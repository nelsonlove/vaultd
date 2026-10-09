//! Task 14's carried measurements on the index side: the numbers the earlier
//! tasks' reviews asked for, timed where the work runs. Every test here is
//! ignored by default (each builds a 10,000-note vault) and asserts nothing
//! about time; each prints a table for the baseline document. Run in release:
//!
//! ```text
//! TMPDIR="$PWD/target/tmp" cargo test --release -p vault-index \
//!     --test bases_timing -- --ignored --nocapture --test-threads 1
//! ```
//!
//! - `publications_while_evaluations_and_resolving_reads_run`: a one-note
//!   publish (`refresh_paths`) with no reader, with one and with four
//!   whole-vault `evaluate_base` loops in flight, and with one loop of
//!   `resolve_link` (each new generation's first resolving read copies the
//!   resolution catalog under the publication guard, so a publication that
//!   lands during that copy waits for it). Phases interleaved, twice each.
//! - `attachment_backlinks_over_ten_thousand_notes`: a view reading
//!   `file.backlinks` over 1,000 attachments that 10,000 notes embed, against
//!   the same rows without it (the row source scans the unresolved
//!   references once per attachment row, with no cache).
//! - `the_value_indexes_cost_on_reconciliation`: a cold build and a one-note
//!   edit with `property_scalars_by_string` and `property_scalars_by_number`
//!   present, and with both dropped before the build; interleaved, twice.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use tempfile::TempDir;
use vault_bases::Clock;
use vault_core::VaultPath;
use vault_index::{BaseQuery, ChangeCause, IndexConfig, IndexReader, IndexService};

const NOTES: usize = 10_000;
const WARM_UP: usize = 5;
const MEASURED: usize = 41;

/// The harness's Bases note shape: a title, a rank, a group tag, a link to
/// the next note.
fn note(index: usize, edit: usize) -> String {
    format!(
        "---\ntitle: Note {index:06}\nrank: {}\n---\n\n# Note {index:06}\n\n#group-{}\n\n[[Note-{:06}]]\n{}",
        index % 100,
        index % 10,
        (index + 1) % NOTES,
        if edit == 0 {
            String::new()
        } else {
            format!("edit {edit}\n")
        },
    )
}

fn write_notes(vault: &Path) {
    for at in 0..NOTES {
        std::fs::write(vault.join(format!("Note-{at:06}.md")), note(at, 0)).unwrap();
    }
}

struct Stats {
    p50: f64,
    p95: f64,
    min: f64,
    max: f64,
    n: usize,
}

fn stats(samples: &mut [f64]) -> Stats {
    samples.sort_by(f64::total_cmp);
    let at = |fraction: f64| samples[((samples.len() - 1) as f64 * fraction).round() as usize];
    Stats {
        p50: at(0.5),
        p95: at(0.95),
        min: samples[0],
        max: samples[samples.len() - 1],
        n: samples.len(),
    }
}

fn millis(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

fn open(vault: &Path, index: &TempDir) -> IndexService {
    let config = IndexConfig::explicit(vault, index.path().join("index.sqlite3")).unwrap();
    IndexService::open(config).unwrap()
}

#[derive(Clone, Copy, Debug)]
enum Load {
    Alone,
    Evaluations(usize),
    Resolving,
}

/// One phase: `WARM_UP + MEASURED` body edits of one note, each published
/// through `refresh_paths` and timed alone, with `load` running on other
/// threads the whole time.
fn publish_phase(
    vault: &Path,
    service: &mut IndexService,
    readers: &[IndexReader],
    load: Load,
    round: &mut usize,
) -> (Vec<f64>, usize, usize) {
    let edited = VaultPath::new("Note-000123.md").unwrap();
    let stop = AtomicBool::new(false);
    let done = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let threads = match load {
        Load::Alone => 0,
        Load::Evaluations(count) => count,
        Load::Resolving => 1,
    };
    let base = VaultPath::new("All.base").unwrap();
    let source = VaultPath::new("Note-000001.md").unwrap();
    let types = BTreeMap::new();
    let mut samples = Vec::with_capacity(MEASURED);
    std::thread::scope(|scope| {
        for reader in readers.iter().take(threads) {
            let (stop, done, failed, base, source, types) =
                (&stop, &done, &failed, &base, &source, &types);
            scope.spawn(move || {
                let clock = Clock::fixed(0, "UTC");
                while !stop.load(Ordering::Relaxed) {
                    let outcome = match load {
                        Load::Resolving => reader
                            .resolve_link(source, "Note-000002")
                            .map(|_| ())
                            .map_err(|error| format!("{error:?}")),
                        _ => reader
                            .evaluate_base(
                                &BaseQuery {
                                    path: base,
                                    view: None,
                                    this_path: None,
                                    types,
                                },
                                &clock,
                            )
                            .map(|_| ())
                            .map_err(|error| format!("{error:?}")),
                    };
                    match outcome {
                        Ok(()) => {
                            done.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(error) => {
                            // The first failure of the phase, for the report.
                            if failed.fetch_add(1, Ordering::Relaxed) == 0 {
                                println!("first failed read ({load:?}): {error}");
                            }
                        }
                    }
                }
            });
        }
        // Let every loop get one request in flight before the first edit.
        std::thread::sleep(std::time::Duration::from_millis(if threads == 0 {
            0
        } else {
            50
        }));
        for at in 0..WARM_UP + MEASURED {
            *round += 1;
            std::fs::write(vault.join(edited.as_str()), note(123, *round)).unwrap();
            let started = Instant::now();
            service
                .refresh_paths(BTreeSet::from([edited.clone()]), ChangeCause::Watcher)
                .unwrap();
            let elapsed = millis(started);
            if at >= WARM_UP {
                samples.push(elapsed);
            }
            // Spaced, so a publication meets a read mid-flight rather than
            // the writer running back to back.
            std::thread::sleep(std::time::Duration::from_millis(7));
        }
        stop.store(true, Ordering::Relaxed);
    });
    (samples, done.into_inner(), failed.into_inner())
}

#[test]
#[ignore = "builds a 10,000-note vault; run in release with --ignored --nocapture"]
fn publications_while_evaluations_and_resolving_reads_run() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    write_notes(vault.path());
    std::fs::write(
        vault.path().join("All.base"),
        "views:\n  - type: table\n    name: All\n    order: [file.name, title]\n",
    )
    .unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    let mut service = open(vault.path(), &index);
    service.refresh(false).unwrap();
    let readers: Vec<IndexReader> = (0..4).map(|_| service.reader().unwrap()).collect();
    // One evaluation alone, for scale.
    let types = BTreeMap::new();
    let base = VaultPath::new("All.base").unwrap();
    let clock = Clock::fixed(0, "UTC");
    let mut alone = Vec::new();
    for _ in 0..5 {
        let started = Instant::now();
        let answer = readers[0]
            .evaluate_base(
                &BaseQuery {
                    path: &base,
                    view: None,
                    this_path: None,
                    types: &types,
                },
                &clock,
            )
            .unwrap();
        alone.push(millis(started));
        assert!(answer.result.total_rows >= NOTES);
    }
    let alone = stats(&mut alone);
    println!(
        "one whole-vault evaluate_base alone (index side, no socket): p50 {:.3} ms, min {:.3} ms, n {}",
        alone.p50, alone.min, alone.n
    );
    println!("| load | round | publish p50 ms | p95 | min | max | n | reads done | reads failed |");
    println!("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    let mut round = 0;
    for pass in 1..=2 {
        for load in [
            Load::Alone,
            Load::Evaluations(1),
            Load::Evaluations(4),
            Load::Resolving,
        ] {
            let (mut samples, done, failed) =
                publish_phase(vault.path(), &mut service, &readers, load, &mut round);
            let s = stats(&mut samples);
            println!(
                "| {load:?} | {pass} | {:.3} | {:.3} | {:.3} | {:.3} | {} | {done} | {failed} |",
                s.p50, s.p95, s.min, s.max, s.n
            );
        }
    }
}

#[test]
#[ignore = "builds a 10,000-note vault; run in release with --ignored --nocapture"]
fn attachment_backlinks_over_ten_thousand_notes() {
    const ATTACHMENTS: usize = 1_000;
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    for at in 0..NOTES {
        std::fs::write(
            vault.path().join(format!("Note-{at:06}.md")),
            format!(
                "---\ntitle: Note {at:06}\n---\n\n![[img-{:04}.png]]\n",
                at % ATTACHMENTS
            ),
        )
        .unwrap();
    }
    for at in 0..ATTACHMENTS {
        std::fs::write(vault.path().join(format!("img-{at:04}.png")), b"png").unwrap();
    }
    std::fs::write(
        vault.path().join("Att.base"),
        "formulas:\n  bl: 'file.backlinks.length'\nviews:\n  - type: table\n    name: Back\n    filters: 'file.ext == \"png\"'\n    order: [file.name, formula.bl]\n  - type: table\n    name: Plain\n    filters: 'file.ext == \"png\"'\n    order: [file.name, file.size]\n",
    )
    .unwrap();
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    let mut service = open(vault.path(), &index);
    service.refresh(false).unwrap();
    let reader = service.reader().unwrap();
    let types = BTreeMap::new();
    let base = VaultPath::new("Att.base").unwrap();
    let clock = Clock::fixed(0, "UTC");
    let time = |view: &str| {
        let started = Instant::now();
        let answer = reader
            .evaluate_base(
                &BaseQuery {
                    path: &base,
                    view: Some(view),
                    this_path: None,
                    types: &types,
                },
                &clock,
            )
            .unwrap();
        let elapsed = millis(started);
        assert_eq!(answer.result.total_rows, ATTACHMENTS, "{view}");
        (elapsed, format!("{:?}", answer.result.rows[0].cells[1]))
    };
    let (mut back, mut plain) = (Vec::new(), Vec::new());
    let mut cell = String::new();
    for _ in 0..5 {
        let (elapsed, first) = time("Back");
        back.push(elapsed);
        cell = first;
        plain.push(time("Plain").0);
    }
    println!("first row's backlinks cell: {cell}");
    for (name, samples) in [("Back (file.backlinks)", &mut back), ("Plain", &mut plain)] {
        let s = stats(samples);
        println!(
            "{name}: 1,000 attachment rows over 10,000 embedding notes: p50 {:.3} ms, p95 {:.3}, min {:.3}, n {}",
            s.p50, s.p95, s.min, s.n
        );
    }
}

fn value_indexes(index: &TempDir) -> usize {
    let connection = rusqlite::Connection::open(index.path().join("index.sqlite3")).unwrap();
    connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN \
             ('property_scalars_by_string', 'property_scalars_by_number')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap() as usize
}

#[test]
#[ignore = "builds a 10,000-note vault; run in release with --ignored --nocapture"]
fn the_value_indexes_cost_on_reconciliation() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    write_notes(vault.path());
    let edited = VaultPath::new("Note-000123.md").unwrap();
    let mut round = 0;
    println!("| value indexes | round | cold build ms | edit p50 ms | edit p95 | edit min | n |");
    println!("| --- | --- | --- | --- | --- | --- | --- |");
    for pass in 1..=2 {
        for with in [true, false] {
            let index = TempDir::new_in(common::scratch_root()).unwrap();
            let mut service = open(vault.path(), &index);
            if !with {
                let connection =
                    rusqlite::Connection::open(index.path().join("index.sqlite3")).unwrap();
                connection
                    .execute_batch(
                        "DROP INDEX property_scalars_by_string; DROP INDEX property_scalars_by_number;",
                    )
                    .unwrap();
            }
            let started = Instant::now();
            service.refresh(false).unwrap();
            let cold = millis(started);
            let mut samples = Vec::new();
            for at in 0..WARM_UP + MEASURED {
                round += 1;
                std::fs::write(vault.path().join(edited.as_str()), note(123, round)).unwrap();
                let started = Instant::now();
                service
                    .refresh_paths(BTreeSet::from([edited.clone()]), ChangeCause::Watcher)
                    .unwrap();
                if at >= WARM_UP {
                    samples.push(millis(started));
                }
            }
            assert_eq!(value_indexes(&index), if with { 2 } else { 0 });
            let s = stats(&mut samples);
            println!(
                "| {} | {pass} | {cold:.1} | {:.3} | {:.3} | {:.3} | {} |",
                if with { "present" } else { "dropped" },
                s.p50,
                s.p95,
                s.min,
                s.n
            );
        }
    }
}
