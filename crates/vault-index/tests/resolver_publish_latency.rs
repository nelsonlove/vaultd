//! The Task 12 review's H3 measurement, kept: does a client that resolves
//! links (every `evaluate_base` and `resolve_link` does) make a one-note
//! publication slower? It must not: the resolver is built by the first
//! resolving read of a generation, outside the publication guard, never by
//! the writer on its commit path.
//!
//! Ignored by default (it builds a 10,000-note vault). Run it in release:
//!
//! ```text
//! TMPDIR="$PWD/target/tmp" cargo test --release -p vault-index \
//!     --test resolver_publish_latency -- --ignored --nocapture
//! ```
//!
//! Method: 10,000 notes from `vault-bench`'s `synthetic_note` shape, cold
//! built; then per phase 5 warm-up and 41 measured body-only edits of one
//! note through `refresh_paths`, timing `refresh_paths` alone. A: a fresh
//! service nobody resolves on. B (the review's method): a fresh service on
//! which a client has resolved once before the phase, which under Task 12's
//! shape made the writer prebuild on every publication. A2: A again, for
//! drift. The test fails if B's median exceeds the larger of A's and A2's by
//! more than 5 percent plus 0.05 ms of timer noise. C, reported and not
//! asserted: a client that also resolves after every publication (untimed),
//! so a read builds every generation's resolver between publications; what
//! it adds is that build's effect on the caches the next publication runs
//! on, not work on the commit path.

mod common;

use std::collections::BTreeSet;
use std::time::Instant;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{ChangeCause, IndexConfig, IndexService};

const NOTES: usize = 10_000;
const WARM_UP: usize = 5;
const MEASURED: usize = 41;
const EDITED: &str = "Note-000123.md";

/// `vault-bench`'s generator, copied: two links each, a tag, a heading.
fn synthetic_note(index: usize, count: usize) -> String {
    let next = (index + 1) % count;
    let previous = (index + count - 1) % count;
    format!(
        "---\ntitle: Note {index:06}\ntags: [synthetic/group-{group}]\n---\n\
         # Note {index:06}\n\
         [[Note-{next:06}]]\n\
         [[Note-{previous:06}#Note {previous:06}]]\n",
        group = index % 100,
    )
}

struct Phase {
    median: f64,
    p95: f64,
    first_resolve: Option<f64>,
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let at = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[at]
}

#[derive(Clone, Copy, PartialEq)]
enum Client {
    None,
    ResolvedOnce,
    ResolvesEveryGeneration,
}

fn phase(vault: &TempDir, index: &TempDir, client: Client, round: &mut usize) -> Phase {
    let config = IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3")).unwrap();
    let mut service = IndexService::open(config).unwrap();
    service.refresh(false).unwrap();
    let reader = service.reader().unwrap();
    let source = VaultPath::new("Note-000001.md").unwrap();
    let mut first_resolve = None;
    if client != Client::None {
        let start = Instant::now();
        reader.resolve_link(&source, "Note-000002").unwrap();
        first_resolve = Some(start.elapsed().as_secs_f64() * 1_000.0);
    }
    let edited = VaultPath::new(EDITED).unwrap();
    let mut samples = Vec::with_capacity(MEASURED);
    for at in 0..WARM_UP + MEASURED {
        *round += 1;
        std::fs::write(
            vault.path().join(EDITED),
            format!("{}\nedit {round}\n", synthetic_note(123, NOTES)),
        )
        .unwrap();
        let start = Instant::now();
        service
            .refresh_paths(BTreeSet::from([edited.clone()]), ChangeCause::Watcher)
            .unwrap();
        let elapsed = start.elapsed().as_secs_f64() * 1_000.0;
        if at >= WARM_UP {
            samples.push(elapsed);
        }
        if client == Client::ResolvesEveryGeneration {
            reader.resolve_link(&source, "Note-000002").unwrap();
        }
    }
    samples.sort_by(f64::total_cmp);
    Phase {
        median: percentile(&samples, 0.5),
        p95: percentile(&samples, 0.95),
        first_resolve,
    }
}

#[test]
#[ignore = "builds a 10,000-note vault; run in release with --ignored"]
fn a_resolving_client_does_not_slow_a_one_note_publication() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    for at in 0..NOTES {
        std::fs::write(
            vault.path().join(format!("Note-{at:06}.md")),
            synthetic_note(at, NOTES),
        )
        .unwrap();
    }
    let mut round = 0;
    let index_a = TempDir::new_in(common::scratch_root()).unwrap();
    let a = phase(&vault, &index_a, Client::None, &mut round);
    let index_b = TempDir::new_in(common::scratch_root()).unwrap();
    let b = phase(&vault, &index_b, Client::ResolvedOnce, &mut round);
    let index_a2 = TempDir::new_in(common::scratch_root()).unwrap();
    let a2 = phase(&vault, &index_a2, Client::None, &mut round);
    let index_c = TempDir::new_in(common::scratch_root()).unwrap();
    let c = phase(
        &vault,
        &index_c,
        Client::ResolvesEveryGeneration,
        &mut round,
    );
    println!("| phase | median ms | p95 ms |");
    println!("| --- | --- | --- |");
    println!(
        "| A, no resolving client | {:.3} | {:.3} |",
        a.median, a.p95
    );
    println!(
        "| B, a client resolved once (the review's method) | {:.3} | {:.3} |",
        b.median, b.p95
    );
    println!(
        "| A2, no resolving client | {:.3} | {:.3} |",
        a2.median, a2.p95
    );
    println!(
        "| C, a client resolving every generation (not asserted) | {:.3} | {:.3} |",
        c.median, c.p95
    );
    println!(
        "first resolving read (builds outside the guard): {:.3} ms",
        b.first_resolve.unwrap_or(0.0)
    );
    let baseline = a.median.max(a2.median);
    println!(
        "B against the larger of A and A2: {:+.1} %",
        (b.median / baseline - 1.0) * 100.0
    );
    assert!(
        b.median <= baseline * 1.05 + 0.05,
        "a resolving client slowed a publication: {:.3} ms against {:.3} ms",
        b.median,
        baseline
    );
}
