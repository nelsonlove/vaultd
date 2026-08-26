use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use clap::Parser;
use vault_core::VaultPath;
use vault_index::{
    FileSystemIndexSource, IndexConfig, IndexService, InventorySnapshot, ReconcileMetrics,
    ReconcileSource, StageDurations,
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
    };
    println!(
        "{}",
        serde_json::to_string(&report).expect("serialize report")
    );
}
