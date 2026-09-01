//! Task 14 runtime-level benchmark: actual watcher hint-to-event latency,
//! cached-read availability, startup catch-up, subscriber delivery, and lag
//! recovery.
//!
//! Unlike `vault-bench` (which drives `IndexService` directly), the
//! watcher-driven cases here start a real [`vault_server::Server`] runtime —
//! real filesystem watcher, real coordinator thread, real notice channel —
//! against a temporary synthetic vault and cache, and parse the real
//! `vault_protocol` event types the stdio transport would ship. Emits
//! exactly one JSON report on stdout; progress goes to stderr.

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use clap::Parser;
use vault_core::VaultPath;
use vault_index::{
    ChangeCause, Generation, IndexConfig, IndexReader, IndexService, LiveRefreshReport, LiveState,
    PathChanges, PublishedStatus, ReconcileMetrics, StageDurations,
};
use vault_protocol::{EventEnvelope, ResyncReasonDto, RuntimeEventDto};
use vault_server::Server;
use vault_server::runtime::{RuntimeNotice, RuntimeOptions};
use vault_server::subscriptions::{SUBSCRIBER_CAPACITY, SubscriptionRegistry};

/// How long a single watcher-driven edit may take to produce its
/// `generation_committed` notice before the benchmark gives up and panics.
/// Generous relative to the design's 500 ms p95 target: a real timeout here
/// means the environment cannot watch at all, not that the target was
/// merely missed.
const HINT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a cold startup catch-up may take at 100,000 notes before the
/// benchmark gives up. Scaled well above the `vault-bench` cold-build
/// baseline (tens of seconds) plus runtime startup overhead.
const CATCH_UP_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(clap::Parser)]
struct Args {
    #[arg(long, value_name = "COUNT", default_value_t = 10_000)]
    notes: usize,
    #[arg(long, default_value_t = 7)]
    repeats: usize,
}

#[derive(serde::Serialize)]
struct LiveBenchReport {
    schema: u32,
    notes: usize,
    repeats: usize,
    cases: Vec<CaseReport>,
}

/// The same per-case shape `vault-bench --live` emits, so both binaries'
/// output is comparable and machine-checkable the same way. `notes` and
/// `affected_references` are repurposed for the two structural,
/// non-watcher cases (`subscriber_delivery`, `lag_recovery`): see each
/// case's own comment and `docs/performance/live-incremental-baseline.md`.
#[derive(serde::Serialize)]
struct CaseReport {
    case: String,
    notes: usize,
    affected_references: u64,
    timings_ms: Distribution,
    stages_ms: StageDistributions,
    work: WorkSummary,
    peak_rss_bytes: Option<u64>,
}

#[derive(serde::Serialize)]
struct Distribution {
    samples: Vec<f64>,
    p50: f64,
    p95: f64,
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

fn empty_distribution() -> Distribution {
    Distribution {
        samples: Vec::new(),
        p50: 0.0,
        p95: 0.0,
    }
}

fn empty_stage_distributions() -> StageDistributions {
    StageDistributions {
        inventory: empty_distribution(),
        body_read: empty_distribution(),
        parse: empty_distribution(),
        impact_planning: empty_distribution(),
        resolution: empty_distribution(),
        candidate_build: empty_distribution(),
        sqlite_write: empty_distribution(),
        sqlite_commit: empty_distribution(),
        live_install: empty_distribution(),
        event_enqueue: empty_distribution(),
    }
}

fn stage_distributions(samples: &[ReconcileMetrics]) -> StageDistributions {
    let ms = |duration: Duration| duration.as_secs_f64() * 1_000.0;
    let pick = |select: fn(&StageDurations) -> Duration| -> Distribution {
        let values: Vec<f64> = samples.iter().map(|m| ms(select(&m.stages))).collect();
        if values.is_empty() {
            empty_distribution()
        } else {
            distribution(values)
        }
    };
    StageDistributions {
        inventory: pick(|s| s.inventory),
        body_read: pick(|s| s.body_read),
        parse: pick(|s| s.parse),
        impact_planning: pick(|s| s.impact_planning),
        resolution: pick(|s| s.resolution),
        candidate_build: pick(|s| s.candidate_build),
        sqlite_write: pick(|s| s.sqlite_write),
        sqlite_commit: pick(|s| s.sqlite_commit),
        live_install: pick(|s| s.live_install),
        event_enqueue: pick(|s| s.event_enqueue),
    }
}

/// Structural work counters, aggregated (summed) across a case's samples —
/// field-for-field with `vault_index::WorkCounts`, plus one benchmark-only
/// counter (`queue_len_before_drain`) the `lag_recovery` case uses to report
/// how deep a collapsed subscriber queue got before it was drained.
#[derive(Default, serde::Serialize)]
struct WorkSummary {
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
    queue_len_before_drain: u64,
}

fn work_from_metrics(samples: &[ReconcileMetrics]) -> WorkSummary {
    let mut work = WorkSummary::default();
    for metrics in samples {
        work.complete_inventories += metrics.work.complete_inventories;
        work.body_reads += metrics.work.body_reads;
        work.notes_reparsed += metrics.work.notes_reparsed;
        work.changed_notes += metrics.work.changed_notes;
        work.affected_references += metrics.work.affected_references;
        work.references_resolved += metrics.work.references_resolved;
        work.note_rows_written += metrics.work.note_rows_written;
        work.reference_rows_written += metrics.work.reference_rows_written;
        work.resolution_rows_written += metrics.work.resolution_rows_written;
        work.dependency_rows_written += metrics.work.dependency_rows_written;
        work.diagnostic_rows_written += metrics.work.diagnostic_rows_written;
    }
    work
}

/// Peak resident set size in bytes since process start. See
/// `vault-bench`'s twin of this function for the platform-conversion
/// rationale; duplicated here because the two benchmarks live in separate
/// crates and no shared bench-support crate exists.
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

fn synthetic_note(index: usize, count: usize) -> String {
    let next = (index + 1) % count;
    let previous = (index + count - 1) % count;
    format!(
        "---\ntitle: Note {index:06}\n---\n\
         # Note {index:06}\n\
         [[Note-{next:06}]]\n\
         [[Note-{previous:06}#Note {previous:06}]]\n",
    )
}

fn build_synthetic_vault(notes: usize) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("synthetic vault dir");
    for index in 0..notes {
        std::fs::write(
            dir.path().join(format!("Note-{index:06}.md")),
            synthetic_note(index, notes),
        )
        .expect("write synthetic note");
    }
    dir
}

fn runtime_options() -> RuntimeOptions {
    RuntimeOptions {
        watch: true,
        watch_config: vault_watch::WatchConfig::default(),
        // No periodic backstop: every generation observed in this
        // benchmark must come from the watcher (or, for `startup_catch_up`,
        // from the startup catch-up itself), never from a coalesced tick.
        reconcile_interval: None,
        command_capacity: 256,
    }
}

/// Block until a `RuntimeNotice::State` names `target`, or `timeout` elapses
/// without one. Other notices (a `Generation` from an unrelated write, or a
/// `ResyncRequired`) are consumed and ignored.
fn wait_for_state(notices: &Receiver<RuntimeNotice>, target: LiveState, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match notices.recv_timeout(remaining) {
            Ok(RuntimeNotice::State { state, .. }) if state == target => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
}

/// Write one fixture note through the real filesystem and block on the
/// notice channel until a `generation_committed` naming that exact path
/// arrives — the actual watcher hint-to-event path, debounce included.
/// Panics (rather than skipping) on timeout: a live-incremental benchmark
/// that cannot observe a single watcher-driven commit indicates a broken
/// environment, not a missed target.
fn write_and_wait_for_generation(
    vault_root: &Path,
    rel: &str,
    body: &str,
    notices: &Receiver<RuntimeNotice>,
) -> (f64, LiveRefreshReport) {
    let target = VaultPath::new(rel).expect("valid vault path");
    let start = Instant::now();
    std::fs::write(vault_root.join(rel), body).expect("write bench note");
    let deadline = start + HINT_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            panic!("no generation_committed notice named {rel} within {HINT_TIMEOUT:?}");
        }
        match notices.recv_timeout(remaining) {
            Ok(RuntimeNotice::Generation(report)) => {
                let touched = report
                    .changes
                    .created
                    .iter()
                    .chain(report.changes.modified.iter())
                    .any(|path| *path == target);
                if touched {
                    let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;
                    return (elapsed_ms, *report);
                }
            }
            Ok(_) => {}
            Err(_) => panic!("the notice channel closed while waiting for {rel}"),
        }
    }
}

/// Write one fixture note and poll `reader.get_note` until it reflects the
/// new body: the total latency from a real filesystem write to a cached
/// read actually observing it, independent of whether anything ever
/// receives the matching event. This is **not** the design's
/// "cached-read availability" target (see `measure_cached_read_at_startup`
/// for that) — it is the post-edit counterpart, reported as
/// `post_edit_cached_read`.
fn write_and_wait_for_read(vault_root: &Path, rel: &str, body: &str, reader: &IndexReader) -> f64 {
    let target = VaultPath::new(rel).expect("valid vault path");
    let start = Instant::now();
    std::fs::write(vault_root.join(rel), body).expect("write bench note");
    let deadline = start + HINT_TIMEOUT;
    loop {
        if let Ok(indexed) = reader.get_note(&target) {
            if indexed.note.source.text() == body {
                return start.elapsed().as_secs_f64() * 1_000.0;
            }
        }
        if Instant::now() >= deadline {
            panic!("cached read for {rel} never reflected the new body within {HINT_TIMEOUT:?}");
        }
        std::thread::sleep(Duration::from_micros(200));
    }
}

/// Watcher hint-to-committed-event latency and cached-read availability,
/// against one running runtime over an already-warm cache. Two dedicated
/// fixture notes (never touched by any other case) keep the two
/// measurements from interfering with each other's notice/read timing.
fn measure_watcher_cases(
    vault_root: &Path,
    index_path: &Path,
    notes: usize,
    repeats: usize,
) -> (CaseReport, CaseReport) {
    let config = IndexConfig::explicit(vault_root, index_path).expect("bench config");
    let (server, notices) = Server::start(config, runtime_options()).expect("start runtime");
    assert!(
        wait_for_state(&notices, LiveState::Watching, HINT_TIMEOUT),
        "the runtime never reached Watching over an already-warm cache"
    );
    let reader = server
        .reader()
        .expect("a running runtime always has a reader");

    let mut hint_samples = Vec::with_capacity(repeats);
    let mut hint_metrics = Vec::with_capacity(repeats);
    for repeat in 0..repeats {
        let body = format!("hint-to-event repeat {repeat}\n");
        let (elapsed_ms, report) =
            write_and_wait_for_generation(vault_root, "Bench-Live-HintToEvent.md", &body, &notices);
        hint_samples.push(elapsed_ms);
        hint_metrics.push(report.metrics);
    }
    let hint_to_event = CaseReport {
        case: "hint_to_committed_event".into(),
        notes,
        affected_references: hint_metrics
            .last()
            .map(|m| m.work.affected_references)
            .unwrap_or(0),
        timings_ms: distribution(hint_samples),
        stages_ms: stage_distributions(&hint_metrics),
        work: work_from_metrics(&hint_metrics),
        peak_rss_bytes: peak_rss_bytes(),
    };

    let mut read_samples = Vec::with_capacity(repeats);
    for repeat in 0..repeats {
        let body = format!("cached-read repeat {repeat}\n");
        let elapsed_ms =
            write_and_wait_for_read(vault_root, "Bench-Live-CachedRead.md", &body, &reader);
        read_samples.push(elapsed_ms);
    }
    let post_edit_cached_read = CaseReport {
        case: "post_edit_cached_read".into(),
        notes,
        affected_references: 0,
        timings_ms: distribution(read_samples),
        // Not captured: the read-polling loop above never inspects the
        // notice channel, so no per-sample `ReconcileMetrics` is available
        // for this case. `hint_to_committed_event` reports the real stage
        // breakdown for the same kind of edit.
        stages_ms: empty_stage_distributions(),
        work: WorkSummary::default(),
        peak_rss_bytes: peak_rss_bytes(),
    };

    server.shutdown();
    (hint_to_event, post_edit_cached_read)
}

/// The design's actual "cached-read availability" target: "when a valid
/// index exists" (an already-warm cache), how long from `Server::start`
/// returning until a read actually succeeds. Restarts a runtime against the
/// same already-warm `index_path` `measure_watcher_cases` just used (which
/// has released the writer lease via its own `shutdown`), so every sample
/// here starts from a real committed generation, not a cold build. Expected
/// to be near-instant: `IndexService::open` hydrates and publishes the
/// existing generation synchronously before `Server::start` ever returns,
/// so a read does not wait for the coordinator's catch-up cycle at all —
/// that is the whole point of "cached reads available before startup
/// catch-up completes" (see the design's Goals).
fn measure_cached_read_at_startup(
    vault_root: &Path,
    index_path: &Path,
    notes: usize,
    repeats: usize,
) -> CaseReport {
    let existing = VaultPath::new("Note-000000.md").expect("valid vault path");
    let mut samples = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let config = IndexConfig::explicit(vault_root, index_path).expect("bench config");
        let start = Instant::now();
        let (server, _notices) = Server::start(config, runtime_options()).expect("start runtime");
        let reader = server
            .reader()
            .expect("a running runtime always has a reader");
        let deadline = start + HINT_TIMEOUT;
        loop {
            if reader.get_note(&existing).is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                panic!(
                    "a read against an already-warm cache never succeeded within {HINT_TIMEOUT:?}"
                );
            }
            std::thread::sleep(Duration::from_micros(50));
        }
        let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;
        server.shutdown();
        samples.push(elapsed_ms);
    }
    CaseReport {
        case: "cached_read_availability".into(),
        notes,
        affected_references: 0,
        timings_ms: distribution(samples),
        stages_ms: empty_stage_distributions(),
        work: WorkSummary::default(),
        peak_rss_bytes: peak_rss_bytes(),
    }
}

/// Startup catch-up from a cold, never-before-opened cache: the worst case
/// `hint_to_committed_event` and `cached_read_availability` are otherwise
/// measured warm against, and this case exists to report the other end
/// honestly. Capped at 3 repeats regardless of `--repeats`: each sample is a
/// full cold build (already measured in isolation by `vault-bench`'s
/// `cold_index` case), so paying it 7 times here would roughly double this
/// binary's wall-clock cost at 100,000 notes for no new information.
fn measure_catch_up(vault_root: &Path, notes: usize, repeats: usize) -> CaseReport {
    let catch_up_repeats = repeats.min(3);
    let mut samples = Vec::with_capacity(catch_up_repeats);
    for repeat in 0..catch_up_repeats {
        let index_dir = tempfile::tempdir().expect("index dir");
        let index_path = index_dir.path().join(format!("catchup-{repeat}.sqlite3"));
        let config = IndexConfig::explicit(vault_root, &index_path).expect("bench config");
        let start = Instant::now();
        let (server, notices) = Server::start(config, runtime_options()).expect("start runtime");
        let reached = wait_for_state(&notices, LiveState::Watching, CATCH_UP_TIMEOUT);
        let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;
        server.shutdown();
        assert!(
            reached,
            "cold startup catch-up never reached Watching within {CATCH_UP_TIMEOUT:?}"
        );
        samples.push(elapsed_ms);
    }
    CaseReport {
        case: "startup_catch_up".into(),
        notes,
        affected_references: 0,
        // Startup catch-up advances the generation through
        // `ResyncReason::RuntimeRecovered`, which carries no per-path
        // `LiveRefreshReport` — there is nothing to attribute stage time or
        // work counters to here. `vault-bench`'s `cold_index` case reports
        // the matching `IndexService`-level stage breakdown for the same
        // work.
        stages_ms: empty_stage_distributions(),
        work: WorkSummary::default(),
        timings_ms: distribution(samples),
        peak_rss_bytes: peak_rss_bytes(),
    }
}

fn synthetic_generation_notice(generation: u64, previous: Option<u64>) -> RuntimeNotice {
    RuntimeNotice::Generation(Box::new(LiveRefreshReport {
        previous_generation: previous.map(Generation::new),
        generation: Generation::new(generation),
        cause: ChangeCause::Watcher,
        changes: PathChanges {
            created: Vec::new(),
            modified: vec![VaultPath::new("Bench-Subscriber.md").expect("valid vault path")],
            deleted: Vec::new(),
        },
        // One note, matching the one path above: this notice stands in for an
        // ordinary single-note generation.
        note_changes: vault_index::NoteChangeCounts {
            created: 0,
            modified: 1,
            deleted: 0,
        },
        affected_reference_count: 1,
        complete_resolution: false,
        metrics: ReconcileMetrics::default(),
    }))
}

fn watching_status() -> PublishedStatus {
    PublishedStatus {
        generation: Some(Generation::new(0)),
        graph_generation: Some(Generation::new(0)),
        live_state: LiveState::Watching,
        runtime_error: None,
    }
}

/// Round-trips one event envelope through the wire encoding: parsing real
/// protocol/runtime events, not just constructing well-typed Rust values.
fn assert_parses_as_wire_json(envelope: &EventEnvelope) {
    let json = serde_json::to_string(envelope).expect("serialize event envelope");
    let parsed: EventEnvelope = serde_json::from_str(&json).expect("deserialize event envelope");
    assert_eq!(parsed.subscription_id, envelope.subscription_id);
}

/// In-process latency from one runtime notice reaching the subscription
/// registry to the matching `EventEnvelope`(s) it produces — the same
/// `SubscriptionRegistry` an embedder driving it directly (per
/// `subscriptions.rs`'s own documented use case) would use. `notes` here is
/// repurposed as "notices offered"; `affected_references` as "events
/// delivered".
fn measure_subscriber_delivery(repeats: usize) -> CaseReport {
    let mut samples = Vec::with_capacity(repeats);
    let mut events_delivered = 0u64;
    for repeat in 0..repeats {
        let mut registry = SubscriptionRegistry::new();
        let response = registry.subscribe(&watching_status());
        registry.activate_new();
        let notice = synthetic_generation_notice(repeat as u64 + 1, Some(repeat as u64));

        let start = Instant::now();
        registry.enqueue_notice(notice);
        let mut envelopes = Vec::new();
        while let Some(envelope) = registry.pop_event() {
            envelopes.push(envelope);
        }
        let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;

        assert!(
            !envelopes.is_empty(),
            "a generation notice delivered to an active subscription must produce at least one event"
        );
        for envelope in &envelopes {
            assert_eq!(envelope.subscription_id, response.subscription_id);
            assert_parses_as_wire_json(envelope);
        }
        events_delivered += envelopes.len() as u64;
        samples.push(elapsed_ms);
    }
    CaseReport {
        case: "subscriber_delivery".into(),
        notes: repeats,
        affected_references: events_delivered,
        timings_ms: distribution(samples),
        stages_ms: empty_stage_distributions(),
        work: WorkSummary::default(),
        peak_rss_bytes: peak_rss_bytes(),
    }
}

/// Feeds one subscription far past `SUBSCRIBER_CAPACITY` without ever
/// draining it, then drains once: the collapse-to-one-marker recovery path
/// `subscriptions.rs` documents. `notes` is repurposed as "notices offered
/// before drain"; `affected_references` as "events emitted by the drain"
/// (bounded, never proportional to notices offered); `work.
/// queue_len_before_drain` is the queue depth just before draining, which
/// must never exceed `SUBSCRIBER_CAPACITY`.
fn measure_lag_recovery() -> CaseReport {
    let mut registry = SubscriptionRegistry::new();
    let response = registry.subscribe(&watching_status());
    registry.activate_new();

    let offered = SUBSCRIBER_CAPACITY + 5;
    for generation in 1..=offered as u64 {
        registry.enqueue_notice(synthetic_generation_notice(
            generation,
            Some(generation - 1),
        ));
    }
    let queue_len_before_drain = registry
        .queue_len(&response.subscription_id)
        .expect("the subscription still exists");
    assert!(
        queue_len_before_drain <= SUBSCRIBER_CAPACITY,
        "a subscriber queue must never grow past its bound, got {queue_len_before_drain}"
    );

    let start = Instant::now();
    let mut drained = Vec::new();
    while let Some(envelope) = registry.pop_event() {
        drained.push(envelope);
    }
    let elapsed_ms = start.elapsed().as_secs_f64() * 1_000.0;

    assert!(
        drained.len() <= 2,
        "a collapsed subscriber queue must drain to at most one state event plus one lag \
         marker, got {}",
        drained.len()
    );
    let has_lag_marker = drained.iter().any(|envelope| {
        matches!(
            &envelope.event,
            RuntimeEventDto::ResyncRequired(resync) if resync.reason == ResyncReasonDto::SubscriberLag
        )
    });
    assert!(
        has_lag_marker,
        "an overflowed subscriber must receive a subscriber_lag marker on drain"
    );
    for envelope in &drained {
        assert_parses_as_wire_json(envelope);
    }

    CaseReport {
        case: "lag_recovery".into(),
        notes: offered,
        affected_references: drained.len() as u64,
        timings_ms: distribution(vec![elapsed_ms]),
        stages_ms: empty_stage_distributions(),
        work: WorkSummary {
            queue_len_before_drain: queue_len_before_drain as u64,
            ..WorkSummary::default()
        },
        peak_rss_bytes: peak_rss_bytes(),
    }
}

fn main() {
    let args = Args::parse();
    assert!(args.notes > 0, "--notes must be greater than zero");
    assert!(args.repeats >= 2, "--repeats must be at least 2");

    eprintln!("generating {} synthetic notes...", args.notes);
    let vault_dir = build_synthetic_vault(args.notes);
    let vault_root = vault_dir.path().to_path_buf();

    eprintln!("cold-building a warm index for the watcher cases...");
    let index_dir = tempfile::tempdir().expect("index dir");
    let index_path: PathBuf = index_dir.path().join("live.sqlite3");
    {
        let config = IndexConfig::explicit(&vault_root, &index_path).expect("bench config");
        let mut service = IndexService::open(config).expect("cold build service");
        service.refresh(false).expect("cold build refresh");
    }

    eprintln!("measuring watcher hint-to-event latency and post-edit cached reads...");
    let (hint_to_event, post_edit_cached_read) =
        measure_watcher_cases(&vault_root, &index_path, args.notes, args.repeats);

    eprintln!("measuring cached-read availability against an already-warm cache...");
    let cached_read_availability =
        measure_cached_read_at_startup(&vault_root, &index_path, args.notes, args.repeats);

    eprintln!("measuring subscriber delivery...");
    let subscriber_delivery = measure_subscriber_delivery(args.repeats);

    eprintln!("measuring lag recovery...");
    let lag_recovery = measure_lag_recovery();

    eprintln!("measuring startup catch-up...");
    let catch_up = measure_catch_up(&vault_root, args.notes, args.repeats);

    let report = LiveBenchReport {
        schema: 1,
        notes: args.notes,
        repeats: args.repeats,
        cases: vec![
            hint_to_event,
            post_edit_cached_read,
            cached_read_availability,
            catch_up,
            subscriber_delivery,
            lag_recovery,
        ],
    };
    println!(
        "{}",
        serde_json::to_string(&report).expect("serialize report")
    );
}
