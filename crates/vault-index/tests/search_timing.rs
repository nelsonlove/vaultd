//! Task 9's index-side search measurements: the numbers the design's
//! performance requirements and the earlier tasks' reviews asked for, timed
//! where the work runs. Every test here is ignored by default (each builds a
//! 10,000-note vault), asserts nothing about time (a timing assertion in the
//! suite is a flake) and prints a table for `docs/performance/search-baseline.md`.
//! What each does assert is the answer, so a broken search cannot pass as a
//! fast one. Run in release:
//!
//! ```text
//! TMPDIR="$PWD/target/tmp" cargo test --release -p vault-index \
//!     --test search_timing -- --ignored --nocapture --test-threads 1
//! ```
//!
//! - `publications_while_a_search_runs`: one whole-vault plain-term search
//!   alone, then a one-note publish (`refresh_paths`) with no reader and with
//!   one whole-vault search loop in flight; phases interleaved, twice each.
//! - `search_costs_by_shape`: index-side search time per query shape, on the
//!   harness's search fixture and on a prose fixture of about 3 KB per note;
//!   the bulk body pass against per-note reads at several kept fractions
//!   (the 1/4 threshold in `query/search.rs`); and the per-match position
//!   cost on one long line.

mod common;

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use tempfile::TempDir;
use vault_core::VaultPath;
use vault_index::{ChangeCause, IndexConfig, IndexReader, IndexService, SearchQuery};
use vault_search::{MemoryDocument, SortOrder, compile, evaluate, parse_query};

const NOTES: usize = 10_000;
const WARM_UP: usize = 5;
const MEASURED: usize = 41;

/// Words for the prose fixture: none holds `meeting`, `group` or `note`, so
/// the answer counts of the measured queries do not move with the prose.
const WORDS: &[&str] = &[
    "the", "river", "lamp", "quietly", "under", "harbor", "stone", "seven", "winter", "basket",
    "orange", "carry", "window", "between", "folded", "market", "silver", "paper", "early",
    "garden", "across", "thunder", "small", "copper", "listen", "valley", "simple", "kettle",
    "bright", "morning", "letter", "a", "of", "and", "with", "toward", "station", "maple",
];

/// A small seeded generator (mulberry32), so the prose is the same bytes on
/// every run.
fn prose(seed: u32, bytes: usize) -> String {
    let mut state = seed.wrapping_mul(0x9E37_79B9).wrapping_add(1);
    let mut next = || {
        state = state.wrapping_add(0x6D2B_79F5);
        let mut t = state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    };
    let mut out = String::with_capacity(bytes + 16);
    let mut line = 0;
    while out.len() < bytes {
        let word = WORDS[next() as usize % WORDS.len()];
        out.push_str(word);
        line += word.len() + 1;
        // Paragraphs of about 400 bytes, as notes are written.
        if line > 400 {
            out.push_str(".\n\n");
            line = 0;
        } else {
            out.push(' ');
        }
    }
    out.push('\n');
    out
}

/// The harness's search fixture shape (`socket-transport-baseline.js
/// --search`): a title, a rank, a heading, a `#group-N` tag line, the line
/// `meeting notes` on every tenth note, optional prose, and a link to the
/// next note.
fn note(index: usize, prose_bytes: usize, edit: usize) -> String {
    format!(
        "---\ntitle: Note {index:06}\nrank: {}\n---\n\n# Note {index:06}\n\n#group-{}\n\n{}{}[[Note-{:06}]]\n{}",
        index % 100,
        index % 10,
        if index % 10 == 0 {
            "meeting notes\n\n"
        } else {
            ""
        },
        if prose_bytes == 0 {
            String::new()
        } else {
            format!("{}\n", prose(index as u32, prose_bytes))
        },
        (index + 1) % NOTES,
        if edit == 0 {
            String::new()
        } else {
            format!("edit {edit}\n")
        },
    )
}

fn write_notes(vault: &Path, prose_bytes: usize) {
    for at in 0..NOTES {
        std::fs::write(
            vault.join(format!("Note-{at:06}.md")),
            note(at, prose_bytes, 0),
        )
        .unwrap();
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

/// One search through the index, and the number of files it answered.
fn search(reader: &IndexReader, query: &str, sort: SortOrder) -> (usize, usize) {
    let compiled = compile(&parse_query(query).unwrap(), false).unwrap();
    let answer = reader
        .search(&SearchQuery {
            compiled: &compiled,
            sort,
        })
        .unwrap();
    (answer.hits.len(), answer.texts_read)
}

/// One phase: `WARM_UP + MEASURED` body edits of one note, each published
/// through `refresh_paths` and timed alone, with `searchers` whole-vault
/// searches looping on other threads the whole time. Every search must
/// answer every note of the fixture.
fn publish_phase(
    vault: &Path,
    service: &mut IndexService,
    readers: &[IndexReader],
    searchers: usize,
    round: &mut usize,
) -> (Vec<f64>, usize) {
    let edited = VaultPath::new("Note-000123.md").unwrap();
    let stop = AtomicBool::new(false);
    let done = AtomicUsize::new(0);
    let mut samples = Vec::with_capacity(MEASURED);
    std::thread::scope(|scope| {
        for reader in readers.iter().take(searchers) {
            let (stop, done) = (&stop, &done);
            scope.spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let (files, _) = search(reader, "note", SortOrder::FileNameAsc);
                    assert_eq!(files, NOTES, "the plain term `note` is in every title");
                    done.fetch_add(1, Ordering::Relaxed);
                }
            });
        }
        // Let every loop get one search in flight before the first edit.
        std::thread::sleep(std::time::Duration::from_millis(if searchers == 0 {
            0
        } else {
            50
        }));
        for at in 0..WARM_UP + MEASURED {
            *round += 1;
            std::fs::write(vault.join(edited.as_str()), note(123, 0, *round)).unwrap();
            let started = Instant::now();
            service
                .refresh_paths(BTreeSet::from([edited.clone()]), ChangeCause::Watcher)
                .unwrap();
            let elapsed = millis(started);
            if at >= WARM_UP {
                samples.push(elapsed);
            }
            // Spaced, so a publication meets a search mid-flight rather than
            // the writer running back to back.
            std::thread::sleep(std::time::Duration::from_millis(7));
        }
        stop.store(true, Ordering::Relaxed);
    });
    (samples, done.into_inner())
}

#[test]
#[ignore = "builds a 10,000-note vault; run in release with --ignored --nocapture"]
fn publications_while_a_search_runs() {
    let vault = TempDir::new_in(common::scratch_root()).unwrap();
    write_notes(vault.path(), 0);
    let index = TempDir::new_in(common::scratch_root()).unwrap();
    let mut service = open(vault.path(), &index);
    service.refresh(false).unwrap();
    let readers: Vec<IndexReader> = (0..1).map(|_| service.reader().unwrap()).collect();
    let mut alone = Vec::new();
    for _ in 0..5 {
        let started = Instant::now();
        let (files, _) = search(&readers[0], "note", SortOrder::FileNameAsc);
        alone.push(millis(started));
        assert_eq!(files, NOTES, "the plain term `note` is in every title");
    }
    let alone = stats(&mut alone);
    println!(
        "one whole-vault search `note` alone (index side, no socket): p50 {:.3} ms, min {:.3} ms, max {:.3} ms, n {}",
        alone.p50, alone.min, alone.max, alone.n
    );
    println!("| load | round | publish p50 ms | p95 | min | max | n | searches done |");
    println!("| --- | --- | --- | --- | --- | --- | --- | --- |");
    let mut round = 0;
    for pass in 1..=2 {
        for searchers in [0, 1] {
            let (mut samples, done) =
                publish_phase(vault.path(), &mut service, &readers, searchers, &mut round);
            let s = stats(&mut samples);
            let load = if searchers == 0 {
                "alone"
            } else {
                "one search in flight"
            };
            println!(
                "| {load} | {pass} | {:.3} | {:.3} | {:.3} | {:.3} | {} | {done} |",
                s.p50, s.p95, s.min, s.max, s.n
            );
        }
    }
}

/// Index-side p50 of `query` over `samples` runs, after two warm-up runs.
fn timed(
    reader: &IndexReader,
    query: &str,
    sort: SortOrder,
    samples: usize,
) -> (Stats, usize, usize) {
    let (files, texts) = search(reader, query, sort);
    search(reader, query, sort);
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = Instant::now();
        let (again, _) = search(reader, query, sort);
        times.push(millis(started));
        assert_eq!(again, files);
    }
    (stats(&mut times), files, texts)
}

/// The two ways `query/search.rs` reads note bodies, timed alone on a plain
/// read connection: one pass over every stored body, against one indexed
/// lookup per kept note, for `fraction` of the notes.
fn body_reads(index_file: &Path, fractions: &[usize]) {
    let connection = rusqlite::Connection::open_with_flags(
        index_file,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let paths: Vec<String> = connection
        .prepare("SELECT path FROM notes ORDER BY path")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let mut bulk = Vec::new();
    for round in 0..7 {
        let started = Instant::now();
        let mut statement = connection
            .prepare("SELECT path, source_bytes FROM notes")
            .unwrap();
        let mut rows = statement.query([]).unwrap();
        let mut bytes = 0;
        while let Some(row) = rows.next().unwrap() {
            bytes += row.get_ref(1).unwrap().as_blob().unwrap().len();
        }
        if round >= 2 {
            bulk.push(millis(started));
        }
        assert!(bytes > 0);
    }
    let bulk = stats(&mut bulk);
    println!(
        "| bulk pass, every body | {} | {:.3} | {:.3} |",
        paths.len(),
        bulk.p50,
        bulk.min
    );
    for &percent in fractions {
        // Every k-th note, spread over the table as a prefilter's survivors are.
        let wanted: Vec<&String> = paths
            .iter()
            .enumerate()
            .filter(|(at, _)| at * percent % 100 < percent)
            .map(|(_, path)| path)
            .collect();
        let mut per_note = Vec::new();
        for round in 0..7 {
            let started = Instant::now();
            let mut statement = connection
                .prepare("SELECT source_bytes FROM notes WHERE path = ?1")
                .unwrap();
            let mut bytes = 0;
            for path in &wanted {
                let mut found = statement.query([path.as_str()]).unwrap();
                let row = found.next().unwrap().unwrap();
                bytes += row.get_ref(0).unwrap().as_blob().unwrap().len();
            }
            if round >= 2 {
                per_note.push(millis(started));
            }
            assert!(bytes > 0);
        }
        let per_note = stats(&mut per_note);
        println!(
            "| per-note reads, {percent} percent | {} | {:.3} | {:.3} |",
            wanted.len(),
            per_note.p50,
            per_note.min
        );
    }
}

#[test]
#[ignore = "builds two 10,000-note vaults; run in release with --ignored --nocapture"]
fn search_costs_by_shape() {
    for prose_bytes in [0, 3_000] {
        let vault = TempDir::new_in(common::scratch_root()).unwrap();
        write_notes(vault.path(), prose_bytes);
        let index = TempDir::new_in(common::scratch_root()).unwrap();
        let mut service = open(vault.path(), &index);
        service.refresh(false).unwrap();
        let reader = service.reader().unwrap();
        println!();
        println!("fixture: {NOTES} notes, prose {prose_bytes} bytes per note");
        println!("| query | sort | files | bodies read | p50 ms | p95 | min | n |");
        println!("| --- | --- | --- | --- | --- | --- | --- | --- |");
        let shapes: &[(&str, SortOrder, usize)] = &[
            ("meeting group", SortOrder::FileNameAsc, 1_000),
            ("meeting group", SortOrder::ModifiedDesc, 1_000),
            ("note", SortOrder::FileNameAsc, NOTES),
            ("note", SortOrder::ModifiedDesc, NOTES),
            ("tag:#group-3", SortOrder::FileNameAsc, 1_000),
            ("file:Note-0001", SortOrder::FileNameAsc, 100),
            ("tag:#group-3 meeting", SortOrder::FileNameAsc, 0),
            ("path:Note-000 meeting", SortOrder::FileNameAsc, 100),
            (
                "(path:Note-001 OR path:Note-002 OR path:Note-003) meeting",
                SortOrder::FileNameAsc,
                300,
            ),
        ];
        for &(query, sort, expected) in shapes {
            let (s, files, texts) = timed(&reader, query, sort, 21);
            assert_eq!(files, expected, "{query}");
            println!(
                "| `{query}` | {sort:?} | {files} | {texts} | {:.3} | {:.3} | {:.3} | {} |",
                s.p50, s.p95, s.min, s.n
            );
        }
        println!();
        println!("| body read | notes | p50 ms | min |");
        println!("| --- | --- | --- | --- |");
        body_reads(
            &index.path().join("index.sqlite3"),
            &[5, 10, 20, 25, 30, 40, 50, 75, 100],
        );
    }

    // The per-match position cost: `LineIndex::loc` measures UTF-16 from the
    // line's start for every reported match (at most `MAX_MATCHES_PER_FILE`),
    // so one long line with many matches is its worst case.
    println!();
    println!("| one note | bytes | matches reported | evaluate p50 ms | min |");
    println!("| --- | --- | --- | --- | --- |");
    for (lines, label) in [(true, "short lines"), (false, "one line")] {
        let mut text = String::new();
        for at in 0..10_000 {
            text.push_str(if at % 100 == 0 { "needle " } else { "filler " });
            if lines && at % 50 == 49 {
                text.push('\n');
            }
        }
        let doc = MemoryDocument::note("Long.md", &text);
        let compiled = compile(&parse_query("needle").unwrap(), false).unwrap();
        let mut times = Vec::new();
        let mut reported = 0;
        for _ in 0..21 {
            let started = Instant::now();
            let hit = evaluate(&compiled, &doc).unwrap();
            times.push(millis(started));
            reported = hit.content_matches.len();
        }
        let s = stats(&mut times);
        println!(
            "| {label} | {} | {reported} | {:.3} | {:.3} |",
            text.len(),
            s.p50,
            s.min
        );
    }
    // The same at a million bytes on one line: 100 reported matches.
    let mut text = String::new();
    for at in 0..140_000 {
        text.push_str(if at % 1_400 == 0 {
            "needle "
        } else {
            "filler "
        });
    }
    let doc = MemoryDocument::note("Huge.md", &text);
    let compiled = compile(&parse_query("needle").unwrap(), false).unwrap();
    let mut times = Vec::new();
    let mut reported = 0;
    for _ in 0..11 {
        let started = Instant::now();
        let hit = evaluate(&compiled, &doc).unwrap();
        times.push(millis(started));
        reported = hit.content_matches.len();
    }
    let s = stats(&mut times);
    println!(
        "| one line, large | {} | {reported} | {:.3} | {:.3} |",
        text.len(),
        s.p50,
        s.min
    );
}
