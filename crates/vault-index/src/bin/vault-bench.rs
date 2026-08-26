use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use clap::Parser;
use vault_core::VaultPath;
use vault_index::{
    ChangeCause, FileSystemIndexSource, IndexConfig, IndexService, InventorySnapshot,
    ReconcileMetrics, ReconcileSource, StageDurations,
};

/// Deterministic benchmark for the persistent read paths. Emits exactly one
/// JSON report on stdout; progress and warnings go to stderr. With `--vault`,
/// the given vault is measured read-only against a temporary index and the
/// `--notes` count is ignored (the enumerated count is reported).
#[derive(clap::Parser)]
struct Args {
    #[arg(long, value_name = "COUNT", default_value_t = 10_000)]
    notes: usize,
    #[arg(long, default_value_t = 7)]
    repeats: usize,
    #[arg(long, value_name = "PATH")]
    vault: Option<PathBuf>,
    /// Also run the Task 14 internal live-incremental cases (body-only edit,
    /// outgoing-reference edit, heading fan-out, filename-resolution
    /// transitions, delete reversals, rename, a 100-note burst, the complete
    /// fallback, and compact-graph hydration). Skipped in `--vault` mode,
    /// which performs no source writes.
    #[arg(long, default_value_t = false)]
    live: bool,
}

/// Peak resident set size in bytes since process start.
///
/// `ru_maxrss` is platform-dependent: bytes on macOS/BSD, kibibytes on
/// Linux. `getrusage` never resets the high-water mark mid-process, so this
/// is a running peak — meaningful as "the largest this process has grown so
/// far", which is exactly what the compact-graph-hydration case (the
/// heaviest working set, run last) wants to report against the 512 MiB
/// design target. `None` on non-Unix platforms, where `getrusage` does not
/// exist.
#[cfg(unix)]
fn peak_rss_bytes() -> Option<u64> {
    // SAFETY: `usage` is a plain-old-data struct that `getrusage` fully
    // populates on success before any field is read; zero-initializing it
    // first is sound because every field is an integer type with no
    // validity invariant narrower than "any bit pattern".
    let usage = unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
            return None;
        }
        usage
    };
    let raw = u64::try_from(usage.ru_maxrss).ok()?;
    if cfg!(target_os = "macos") {
        Some(raw)
    } else {
        Some(raw.saturating_mul(1024))
    }
}

#[cfg(not(unix))]
fn peak_rss_bytes() -> Option<u64> {
    None
}

#[derive(serde::Serialize)]
struct BenchmarkReport {
    schema: u32,
    mode: String,
    note_count: usize,
    repeats: usize,
    timings_ms: BenchmarkTimings,
    work: BenchmarkWork,
    stages: BenchmarkStages,
    /// The Task 14 internal live-incremental cases, one entry per named
    /// case. Empty unless `--live` was passed, and always empty in
    /// `--vault` mode (real-vault runs perform no source writes).
    live_cases: Vec<CaseReport>,
}

/// One live-incremental case: a single measured operation (a targeted
/// `refresh_paths` call, or a graph hydration), repeated `--repeats` times.
/// `stages_ms` and `work` mirror `ReconcileMetrics` field-for-field, exactly
/// as `BenchmarkStages`/`StructuralWork` already do for the persistent-index
/// cases above.
#[derive(serde::Serialize)]
struct CaseReport {
    case: String,
    notes: usize,
    affected_references: u64,
    timings_ms: Distribution,
    stages_ms: StageDistributions,
    work: StructuralWork,
    peak_rss_bytes: Option<u64>,
}

#[derive(serde::Serialize)]
struct BenchmarkTimings {
    cold_index: Distribution,
    warm_startup: Distribution,
    one_file_refresh: Distribution,
    verified_refresh: Distribution,
    get_note: Distribution,
    backlinks: Distribution,
    list_100: Distribution,
}

#[derive(serde::Serialize)]
struct Distribution {
    samples: Vec<f64>,
    p50: f64,
    p95: f64,
}

#[derive(serde::Serialize)]
struct BenchmarkWork {
    warm_startup_body_reads: u64,
    warm_startup_reparsed: u64,
    one_file_refresh_body_reads: u64,
    one_file_refresh_reparsed: u64,
    warm_startup: StructuralWork,
    one_file_refresh: StructuralWork,
}

/// Structural work counters aggregated (summed) across a sample's repeats,
/// mirroring `vault_index::WorkCounts` field-for-field.
#[derive(Default, serde::Serialize)]
struct StructuralWork {
    complete_inventories: u64,
    body_reads: u64,
    notes_reparsed: u64,
    changed_notes: u64,
    affected_references: u64,
    references_resolved: u64,
    note_rows_written: u64,
    reference_rows_written: u64,
    resolution_rows_written: u64,
    dependency_rows_written: u64,
    diagnostic_rows_written: u64,
}

fn aggregate_work(samples: &[ReconcileMetrics]) -> StructuralWork {
    let mut aggregate = StructuralWork::default();
    for metrics in samples {
        aggregate.complete_inventories += metrics.work.complete_inventories;
        aggregate.body_reads += metrics.work.body_reads;
        aggregate.notes_reparsed += metrics.work.notes_reparsed;
        aggregate.changed_notes += metrics.work.changed_notes;
        aggregate.affected_references += metrics.work.affected_references;
        aggregate.references_resolved += metrics.work.references_resolved;
        aggregate.note_rows_written += metrics.work.note_rows_written;
        aggregate.reference_rows_written += metrics.work.reference_rows_written;
        aggregate.resolution_rows_written += metrics.work.resolution_rows_written;
        aggregate.dependency_rows_written += metrics.work.dependency_rows_written;
        aggregate.diagnostic_rows_written += metrics.work.diagnostic_rows_written;
    }
    aggregate
}

/// Stage-duration p50/p95 groups, one distribution per `StageDurations`
/// field, in milliseconds.
#[derive(serde::Serialize)]
struct StageDistributions {
    inventory: Distribution,
    body_read: Distribution,
    parse: Distribution,
    impact_planning: Distribution,
    resolution: Distribution,
    candidate_build: Distribution,
    sqlite_write: Distribution,
    sqlite_commit: Distribution,
    live_install: Distribution,
    event_enqueue: Distribution,
}

#[derive(serde::Serialize)]
struct BenchmarkStages {
    warm_startup: StageDistributions,
    one_file_refresh: StageDistributions,
}

fn stage_millis(
    samples: &[ReconcileMetrics],
    pick: impl Fn(&StageDurations) -> f64,
) -> Distribution {
    let millis: Vec<f64> = samples
        .iter()
        .map(|metrics| pick(&metrics.stages))
        .collect();
    if millis.is_empty() {
        empty_distribution()
    } else {
        distribution(millis)
    }
}

fn stage_distributions(samples: &[ReconcileMetrics]) -> StageDistributions {
    let ms = |duration: std::time::Duration| duration.as_secs_f64() * 1_000.0;
    StageDistributions {
        inventory: stage_millis(samples, |s| ms(s.inventory)),
        body_read: stage_millis(samples, |s| ms(s.body_read)),
        parse: stage_millis(samples, |s| ms(s.parse)),
        impact_planning: stage_millis(samples, |s| ms(s.impact_planning)),
        resolution: stage_millis(samples, |s| ms(s.resolution)),
        candidate_build: stage_millis(samples, |s| ms(s.candidate_build)),
        sqlite_write: stage_millis(samples, |s| ms(s.sqlite_write)),
        sqlite_commit: stage_millis(samples, |s| ms(s.sqlite_commit)),
        live_install: stage_millis(samples, |s| ms(s.live_install)),
        event_enqueue: stage_millis(samples, |s| ms(s.event_enqueue)),
    }
}

fn distribution(mut samples: Vec<f64>) -> Distribution {
    assert!(!samples.is_empty(), "timed distributions require samples");
    samples.sort_by(f64::total_cmp);
    let percentile = |fraction: f64| {
        let index = ((samples.len() - 1) as f64 * fraction).ceil() as usize;
        samples[index]
    };
    Distribution {
        p50: percentile(0.50),
        p95: percentile(0.95),
        samples,
    }
}

fn empty_distribution() -> Distribution {
    Distribution {
        samples: Vec::new(),
        p50: 0.0,
        p95: 0.0,
    }
}

struct CountingSource {
    inner: FileSystemIndexSource,
    body_reads: Arc<AtomicU64>,
}

impl ReconcileSource for CountingSource {
    fn canonical_root(&self) -> &Path {
        self.inner.canonical_root()
    }

    fn inventory(&self) -> Result<InventorySnapshot, vault_index::IndexError> {
        self.inner.inventory()
    }

    fn read_bytes(&self, path: &VaultPath) -> Result<Vec<u8>, vault_core::ScanError> {
        self.body_reads.fetch_add(1, Ordering::SeqCst);
        self.inner.read_bytes(path)
    }

    fn fingerprint(
        &self,
        path: &VaultPath,
    ) -> Result<Option<vault_index::FileFingerprint>, vault_index::IndexError> {
        self.inner.fingerprint(path)
    }
}

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

fn timed(instant_work: impl FnOnce()) -> f64 {
    let start = Instant::now();
    instant_work();
    start.elapsed().as_secs_f64() * 1_000.0
}

fn open_counting_service(vault_root: &Path, index_path: &Path) -> (IndexService, Arc<AtomicU64>) {
    let config = IndexConfig::explicit(vault_root, index_path).expect("benchmark config");
    let body_reads = Arc::new(AtomicU64::new(0));
    let source = CountingSource {
        inner: FileSystemIndexSource::new(vault_root).expect("benchmark source"),
        body_reads: Arc::clone(&body_reads),
    };
    let service =
        IndexService::open_with_source(config, Box::new(source)).expect("benchmark service");
    (service, body_reads)
}

// ---------------------------------------------------------------------------
// Task 14 live-incremental cases
// ---------------------------------------------------------------------------
//
// Every case below drives `IndexService::refresh_paths` directly — the same
// engine `--vault`'s ordinary watcher-driven refresh uses — against small,
// dedicated `Bench-*` fixture notes layered on top of the numbered synthetic
// vault. `refresh_paths` re-reads and re-fingerprints every given path
// unconditionally, so no fixture needs an mtime bump: a changed body is
// enough to make `classify` see a moved content revision.

/// One measured `refresh_paths` call.
struct CaseSample {
    elapsed_ms: f64,
    metrics: ReconcileMetrics,
    affected_references: u64,
}

/// Write one fixture note's body, creating any parent directory the fixture
/// needs, and return its `VaultPath`.
fn write_note_body(vault_root: &Path, rel: &str, body: &str) -> VaultPath {
    let path = vault_root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create fixture directory");
    }
    std::fs::write(&path, body).expect("write fixture note");
    VaultPath::new(rel).expect("valid vault path")
}

fn remove_note(vault_root: &Path, rel: &str) {
    std::fs::remove_file(vault_root.join(rel)).expect("remove fixture note");
}

/// The body a toggle case should write next: whichever of `primary`/
/// `secondary` differs from what is on disk right now. Reading current
/// content rather than alternating on the repeat index makes every toggle
/// case robust to whatever state an earlier case (or a run with an odd
/// `--repeats`) left the fixture in — a fixture reused across two cases
/// (`complete_fallback_after_overflow` reuses `heading_fanout_10`'s hub)
/// would otherwise risk writing a no-op body that never advances the
/// generation at all.
fn toggle_body(vault_root: &Path, rel: &str, primary: &str, secondary: &str) -> String {
    let current = std::fs::read_to_string(vault_root.join(rel)).unwrap_or_default();
    if current == primary {
        secondary.to_string()
    } else {
        primary.to_string()
    }
}

/// Seed one or more fixture paths into the index without timing it — every
/// case's own measured loop times only the transition under test, never the
/// fixture's first appearance.
fn seed(service: &mut IndexService, paths: impl IntoIterator<Item = VaultPath>) {
    let set: BTreeSet<VaultPath> = paths.into_iter().collect();
    service
        .refresh_paths(set, ChangeCause::Manual)
        .expect("seed live-case fixtures");
}

fn measure(service: &mut IndexService, paths: BTreeSet<VaultPath>) -> CaseSample {
    let start = Instant::now();
    let report = service
        .refresh_paths(paths, ChangeCause::Manual)
        .expect("refresh_paths");
    let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;
    CaseSample {
        elapsed_ms,
        metrics: report.metrics,
        affected_references: report.affected_reference_count,
    }
}

fn case_report(name: &str, notes: usize, samples: &[CaseSample]) -> CaseReport {
    let affected_references = samples.last().map(|s| s.affected_references).unwrap_or(0);
    let timings: Vec<f64> = samples.iter().map(|s| s.elapsed_ms).collect();
    let metrics: Vec<ReconcileMetrics> = samples.iter().map(|s| s.metrics.clone()).collect();
    CaseReport {
        case: name.to_string(),
        notes,
        affected_references,
        timings_ms: distribution(timings),
        stages_ms: stage_distributions(&metrics),
        work: aggregate_work(&metrics),
        peak_rss_bytes: peak_rss_bytes(),
    }
}

/// Body-only edit with zero outgoing references and zero incoming fan-in: a
/// change with no reference to re-resolve at all.
fn case_body_only_edit(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    let isolated = write_note_body(vault_root, "Bench-Isolated.md", "seed body\n");
    seed(service, [isolated.clone()]);
    let mut samples = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let body = toggle_body(
            vault_root,
            "Bench-Isolated.md",
            "seed body\n",
            "alternate body text\n",
        );
        write_note_body(vault_root, "Bench-Isolated.md", &body);
        samples.push(measure(service, BTreeSet::from([isolated.clone()])));
    }
    case_report("body_only_edit", notes, &samples)
}

/// Editing which note an outgoing reference targets: exactly one reference
/// (the source's own) is re-resolved.
fn case_outgoing_reference_edit(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    let target_a = write_note_body(vault_root, "Bench-OutgoingTargetA.md", "# A\n");
    let target_b = write_note_body(vault_root, "Bench-OutgoingTargetB.md", "# B\n");
    let source = write_note_body(
        vault_root,
        "Bench-OutgoingSource.md",
        "[[Bench-OutgoingTargetA]]\n",
    );
    seed(service, [target_a, target_b, source.clone()]);
    let mut samples = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let body = toggle_body(
            vault_root,
            "Bench-OutgoingSource.md",
            "[[Bench-OutgoingTargetA]]\n",
            "[[Bench-OutgoingTargetB]]\n",
        );
        write_note_body(vault_root, "Bench-OutgoingSource.md", &body);
        samples.push(measure(service, BTreeSet::from([source.clone()])));
    }
    case_report("outgoing_reference_edit", notes, &samples)
}

/// Adding and removing a heading under a fan-out of `fanout` subpath
/// references, at labels `0`, `10`, `100`, and `high` (1,000): every
/// referencing note's incoming reference must be re-resolved each toggle.
fn case_heading_fanout(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
    label: &str,
    fanout: usize,
) -> CaseReport {
    let hub_rel = format!("Bench-Hub-{label}.md");
    let hub = write_note_body(vault_root, &hub_rel, "## Shared\nhub body\n");
    let mut seed_paths = vec![hub.clone()];
    for index in 0..fanout {
        let rel = format!("Bench-FanIn-{label}-{index:04}.md");
        let body = format!("[[Bench-Hub-{label}#Shared]]\n");
        seed_paths.push(write_note_body(vault_root, &rel, &body));
    }
    seed(service, seed_paths);
    let mut samples = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let body = toggle_body(vault_root, &hub_rel, "## Shared\nhub body\n", "hub body\n");
        write_note_body(vault_root, &hub_rel, &body);
        samples.push(measure(service, BTreeSet::from([hub.clone()])));
    }
    case_report(&format!("heading_fanout_{label}"), notes, &samples)
}

/// The appearance of the first nested spelling of an otherwise-unused stem
/// resolves a bare-filename reference from `Unresolved` to `Resolved`
/// against a single candidate; a second nested spelling then makes the same
/// reference `Ambiguous`; deleting each nested spelling again walks both
/// transitions backward. Neither nested path is ever an exact match for the
/// reference's own bare spelling, so no candidate ever wins by exact path —
/// the same three-way pattern `tests/live_oracle.rs`'s `SLOTS` fixture uses.
fn case_filename_resolution_transitions(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> Vec<CaseReport> {
    let source = write_note_body(
        vault_root,
        "Bench-Filename-Source.md",
        "[[Bench-Filename-Target]]\n",
    );
    seed(service, [source]);

    let candidate_a_rel = "Bench-Dir1/Bench-Filename-Target.md";
    let candidate_a = VaultPath::new(candidate_a_rel).expect("valid vault path");
    let candidate_b_rel = "Bench-Dir2/Bench-Filename-Target.md";
    let candidate_b = VaultPath::new(candidate_b_rel).expect("valid vault path");

    let reset_absent =
        |vault_root: &Path, service: &mut IndexService, rel: &str, path: &VaultPath| {
            if vault_root.join(rel).exists() {
                remove_note(vault_root, rel);
                service
                    .refresh_paths(BTreeSet::from([path.clone()]), ChangeCause::Manual)
                    .expect("reset fixture to absent");
            }
        };
    let reset_present =
        |vault_root: &Path, service: &mut IndexService, rel: &str, path: &VaultPath| {
            if !vault_root.join(rel).exists() {
                write_note_body(vault_root, rel, "# Target\n");
                service
                    .refresh_paths(BTreeSet::from([path.clone()]), ChangeCause::Manual)
                    .expect("reset fixture to present");
            }
        };

    let mut unresolved_to_resolved = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        reset_absent(vault_root, service, candidate_a_rel, &candidate_a);
        write_note_body(vault_root, candidate_a_rel, "# Target\n");
        unresolved_to_resolved.push(measure(service, BTreeSet::from([candidate_a.clone()])));
    }

    let mut resolved_to_ambiguous = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        reset_absent(vault_root, service, candidate_b_rel, &candidate_b);
        write_note_body(vault_root, candidate_b_rel, "# Target\n");
        resolved_to_ambiguous.push(measure(service, BTreeSet::from([candidate_b.clone()])));
    }

    let mut delete_reversals = Vec::with_capacity(repeats * 2);
    for _ in 0..repeats {
        reset_present(vault_root, service, candidate_b_rel, &candidate_b);
        remove_note(vault_root, candidate_b_rel);
        delete_reversals.push(measure(service, BTreeSet::from([candidate_b.clone()])));

        reset_present(vault_root, service, candidate_a_rel, &candidate_a);
        remove_note(vault_root, candidate_a_rel);
        delete_reversals.push(measure(service, BTreeSet::from([candidate_a.clone()])));
    }

    vec![
        case_report("unresolved_to_resolved", notes, &unresolved_to_resolved),
        case_report("resolved_to_ambiguous", notes, &resolved_to_ambiguous),
        case_report("delete_reversals", notes, &delete_reversals),
    ]
}

/// A rename delivered as one coalesced batch: the old path deleted and the
/// new path created in the same `refresh_paths` call, exactly as the
/// runtime coordinator batches a paired watcher hint.
fn case_rename(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    let first_rel = "Bench-Rename-A.md";
    let second_rel = "Bench-Rename-B.md";
    write_note_body(vault_root, first_rel, "# Rename\nbody\n");
    seed(
        service,
        [VaultPath::new(first_rel).expect("valid vault path")],
    );

    let mut current_rel = first_rel;
    let mut other_rel = second_rel;
    let mut samples = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let body =
            std::fs::read_to_string(vault_root.join(current_rel)).expect("read rename source");
        remove_note(vault_root, current_rel);
        write_note_body(vault_root, other_rel, &body);
        let old = VaultPath::new(current_rel).expect("valid vault path");
        let new = VaultPath::new(other_rel).expect("valid vault path");
        samples.push(measure(service, BTreeSet::from([old, new])));
        std::mem::swap(&mut current_rel, &mut other_rel);
    }
    case_report("rename", notes, &samples)
}

/// One hundred notes changed in a single batch, as a debounced burst of
/// editor saves would arrive.
fn case_burst_100_notes(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    let burst_count = notes.min(100);
    let burst_paths: Vec<VaultPath> = (0..burst_count)
        .map(|index| VaultPath::new(format!("Note-{index:06}.md")).expect("valid vault path"))
        .collect();
    let mut samples = Vec::with_capacity(repeats);
    for repeat in 0..repeats {
        for (index, path) in burst_paths.iter().enumerate() {
            let mut body = synthetic_note(index, notes);
            if repeat % 2 == 0 {
                body.push_str("\nBurst variant\n");
            }
            std::fs::write(vault_root.join(path.as_str()), body).expect("write burst note");
        }
        samples.push(measure(service, burst_paths.iter().cloned().collect()));
    }
    // Restore, so the burst leaves no lingering variant behind for whatever
    // runs next.
    for (index, path) in burst_paths.iter().enumerate() {
        std::fs::write(vault_root.join(path.as_str()), synthetic_note(index, notes))
            .expect("restore burst note");
    }
    service
        .refresh_paths(burst_paths.into_iter().collect(), ChangeCause::Manual)
        .expect("settle burst notes");
    case_report("burst_100_notes", notes, &samples)
}

/// Forces the internal complete-resolution fallback inside `refresh_paths`
/// (`select_impact`'s selected-count threshold, the same branch
/// `set_complete_resolution_threshold_for_test` exists to make reachable
/// without a ten-thousand-reference vault) by lowering the threshold to 1
/// and reusing the 10-fan-in heading hub.
///
/// This is **not** the runtime's watcher-overflow full reconciliation (a
/// separate, whole-vault code path in `vault-server`'s coordinator, exercised
/// by `vault-live-bench`'s runtime-level cases) — it is the internal
/// resolution-scope fallback the design calls out under "Large or uncertain
/// changes". Named to match the brief's case list; the distinction is
/// disclosed here and in the performance report for benchmark honesty.
fn case_complete_fallback(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    service.set_complete_resolution_threshold_for_test(1);
    let hub_rel = "Bench-Hub-10.md";
    let hub = VaultPath::new(hub_rel).expect("valid vault path");
    let mut samples = Vec::with_capacity(repeats);
    let mut every_attempt_forced_complete = true;
    for _ in 0..repeats {
        let body = toggle_body(vault_root, hub_rel, "## Shared\nhub body\n", "hub body\n");
        write_note_body(vault_root, hub_rel, &body);
        let start = Instant::now();
        let report = service
            .refresh_paths(BTreeSet::from([hub.clone()]), ChangeCause::Manual)
            .expect("refresh_paths");
        let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;
        every_attempt_forced_complete &= report.complete_resolution;
        samples.push(CaseSample {
            elapsed_ms,
            metrics: report.metrics,
            affected_references: report.affected_reference_count,
        });
    }
    assert!(
        every_attempt_forced_complete,
        "the forced-threshold case never reached the complete-resolution fallback"
    );
    case_report("complete_fallback_after_overflow", notes, &samples)
}

/// Hydrating the compact live graph from SQLite: no source body is read.
/// Run last, so its `peak_rss_bytes` — the largest working-set moment in
/// this process — is the figure compared against the design's 512 MiB
/// target.
fn case_compact_graph_hydration(
    service: &IndexService,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    let mut samples = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let start = Instant::now();
        let graph = service.hydrate_live_graph().expect("hydrate live graph");
        let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;
        samples.push(CaseSample {
            elapsed_ms,
            metrics: ReconcileMetrics::default(),
            affected_references: graph.reference_count() as u64,
        });
    }
    case_report("compact_graph_hydration", notes, &samples)
}

fn run_live_cases(
    vault_root: &Path,
    service: &mut IndexService,
    notes: usize,
    repeats: usize,
) -> Vec<CaseReport> {
    let mut cases = Vec::new();
    cases.push(case_body_only_edit(vault_root, service, notes, repeats));
    cases.push(case_outgoing_reference_edit(
        vault_root, service, notes, repeats,
    ));
    for (label, fanout) in [("0", 0usize), ("10", 10), ("100", 100), ("high", 1_000)] {
        cases.push(case_heading_fanout(
            vault_root, service, notes, repeats, label, fanout,
        ));
    }
    cases.extend(case_filename_resolution_transitions(
        vault_root, service, notes, repeats,
    ));
    cases.push(case_rename(vault_root, service, notes, repeats));
    cases.push(case_burst_100_notes(vault_root, service, notes, repeats));
    cases.push(case_complete_fallback(vault_root, service, notes, repeats));
    cases.push(case_compact_graph_hydration(service, notes, repeats));
    cases
}

fn main() {
    let args = Args::parse();
    assert!(args.notes > 0, "--notes must be greater than zero");
    assert!(args.repeats >= 2, "--repeats must be at least 2");

    let synthetic_dir;
    let (vault_root, mode) = match &args.vault {
        Some(vault) => (vault.clone(), "real"),
        None => {
            eprintln!("generating {} synthetic notes...", args.notes);
            let dir = tempfile::tempdir().expect("synthetic vault dir");
            for index in 0..args.notes {
                std::fs::write(
                    dir.path().join(format!("Note-{index:06}.md")),
                    synthetic_note(index, args.notes),
                )
                .expect("write synthetic note");
            }
            let path = dir.path().to_path_buf();
            synthetic_dir = Some(dir);
            let _ = &synthetic_dir;
            (path, "synthetic")
        }
    };

    let index_dir = tempfile::tempdir().expect("index dir");

    // Cold builds: a fresh database per repeat.
    eprintln!("measuring cold builds...");
    let mut cold_samples = Vec::with_capacity(args.repeats);
    for repeat in 0..args.repeats {
        let index_path = index_dir.path().join(format!("cold-{repeat}.sqlite3"));
        let (mut service, _) = open_counting_service(&vault_root, &index_path);
        cold_samples.push(timed(|| {
            service.refresh(false).expect("cold refresh");
        }));
    }

    // One persistent index for every warm measurement.
    let warm_index_path = index_dir.path().join("warm.sqlite3");
    {
        let (mut service, _) = open_counting_service(&vault_root, &warm_index_path);
        service.refresh(false).expect("warm base build");
    }

    eprintln!("measuring warm startups...");
    let mut warm_samples = Vec::with_capacity(args.repeats);
    let mut warm_startup_body_reads = 0u64;
    let mut warm_startup_reparsed = 0u64;
    let mut warm_metrics: Vec<ReconcileMetrics> = Vec::with_capacity(args.repeats);
    for _ in 0..args.repeats {
        let (mut service, body_reads) = open_counting_service(&vault_root, &warm_index_path);
        body_reads.store(0, Ordering::SeqCst);
        let mut reparsed = 0;
        warm_samples.push(timed(|| {
            reparsed = service.refresh(false).expect("warm refresh").reparsed;
        }));
        warm_startup_body_reads += body_reads.load(Ordering::SeqCst);
        warm_startup_reparsed += reparsed;
        warm_metrics.push(
            service
                .last_reconcile_metrics()
                .cloned()
                .expect("warm refresh metrics"),
        );
    }

    let (mut service, body_reads) = open_counting_service(&vault_root, &warm_index_path);
    service.refresh(false).expect("settle warm service");

    // One-file refresh: alternate one synthetic note between two same-shape
    // bodies with a strictly increasing modification time.
    let (one_file_samples, one_file_reads, one_file_reparsed, one_file_metrics) =
        if mode == "synthetic" {
            eprintln!("measuring one-file refreshes...");
            let target = vault_root.join("Note-000000.md");
            let base_body = synthetic_note(0, args.notes);
            let alternate_body = base_body.replace("# Note 000000", "# NOTE 000000");
            let metadata = std::fs::metadata(&target).expect("target metadata");
            let mut mtime = filetime::FileTime::from_last_modification_time(&metadata);
            let mut samples = Vec::with_capacity(args.repeats);
            let mut reads = 0u64;
            let mut reparsed = 0u64;
            let mut metrics_samples: Vec<ReconcileMetrics> = Vec::with_capacity(args.repeats);
            for repeat in 0..args.repeats {
                let body = if repeat % 2 == 0 {
                    &alternate_body
                } else {
                    &base_body
                };
                std::fs::write(&target, body).expect("alternate target note");
                mtime = filetime::FileTime::from_unix_time(mtime.unix_seconds() + 2, 0);
                filetime::set_file_mtime(&target, mtime).expect("bump target mtime");
                body_reads.store(0, Ordering::SeqCst);
                let mut sample_reparsed = 0;
                samples.push(timed(|| {
                    sample_reparsed = service.refresh(false).expect("one-file refresh").reparsed;
                }));
                reads += body_reads.load(Ordering::SeqCst);
                reparsed += sample_reparsed;
                metrics_samples.push(
                    service
                        .last_reconcile_metrics()
                        .cloned()
                        .expect("one-file refresh metrics"),
                );
            }
            std::fs::write(&target, &base_body).expect("restore target note");
            mtime = filetime::FileTime::from_unix_time(mtime.unix_seconds() + 2, 0);
            filetime::set_file_mtime(&target, mtime).expect("restore target mtime");
            service.refresh(false).expect("settle after restore");
            (distribution(samples), reads, reparsed, metrics_samples)
        } else {
            eprintln!("real-vault mode performs no source writes; one-file refresh is skipped");
            (empty_distribution(), 0, 0, Vec::new())
        };

    eprintln!("measuring verified refreshes...");
    let mut verified_samples = Vec::with_capacity(args.repeats);
    for _ in 0..args.repeats {
        verified_samples.push(timed(|| {
            service.refresh(true).expect("verified refresh");
        }));
    }

    // Warm queries with one untimed warm-up each.
    eprintln!("measuring warm queries...");
    let listing = service.list_notes(None, Some(100)).expect("first page");
    let middle = listing.items[listing.items.len() / 2].path.clone();

    service.get_note(&middle).expect("get_note warm-up");
    let mut get_note_samples = Vec::with_capacity(args.repeats);
    for _ in 0..args.repeats {
        get_note_samples.push(timed(|| {
            service.get_note(&middle).expect("get_note");
        }));
    }

    service
        .get_backlinks(&middle, None, Some(100))
        .expect("backlinks warm-up");
    let mut backlink_samples = Vec::with_capacity(args.repeats);
    for _ in 0..args.repeats {
        backlink_samples.push(timed(|| {
            service
                .get_backlinks(&middle, None, Some(100))
                .expect("backlinks");
        }));
    }

    service.list_notes(None, Some(100)).expect("list warm-up");
    let mut list_samples = Vec::with_capacity(args.repeats);
    for _ in 0..args.repeats {
        list_samples.push(timed(|| {
            service.list_notes(None, Some(100)).expect("list page");
        }));
    }

    let live_cases = if args.live && mode == "synthetic" {
        eprintln!("measuring live-incremental cases...");
        run_live_cases(&vault_root, &mut service, args.notes, args.repeats)
    } else {
        if args.live {
            eprintln!("real-vault mode performs no source writes; live cases are skipped");
        }
        Vec::new()
    };

    let note_count = usize::try_from(service.vault_info().expect("vault info").note_count)
        .expect("note count fits usize");
    let report = BenchmarkReport {
        schema: 1,
        mode: mode.to_string(),
        note_count,
        repeats: args.repeats,
        timings_ms: BenchmarkTimings {
            cold_index: distribution(cold_samples),
            warm_startup: distribution(warm_samples),
            one_file_refresh: one_file_samples,
            verified_refresh: distribution(verified_samples),
            get_note: distribution(get_note_samples),
            backlinks: distribution(backlink_samples),
            list_100: distribution(list_samples),
        },
        work: BenchmarkWork {
            warm_startup_body_reads,
            warm_startup_reparsed,
            one_file_refresh_body_reads: one_file_reads,
            one_file_refresh_reparsed: one_file_reparsed,
            warm_startup: aggregate_work(&warm_metrics),
            one_file_refresh: aggregate_work(&one_file_metrics),
        },
        stages: BenchmarkStages {
            warm_startup: stage_distributions(&warm_metrics),
            one_file_refresh: stage_distributions(&one_file_metrics),
        },
        live_cases,
    };
    println!(
        "{}",
        serde_json::to_string(&report).expect("serialize report")
    );
}
