//! Smoke test for `vault-live-bench`: a small, fast run
//! (`--notes 25 --repeats 2`) that asserts the JSON schema, every named
//! runtime-level case is present, and the structural invariants the binary
//! itself already asserts internally (a subscriber queue never exceeds its
//! bound, a collapsed queue drains to at most one state event plus one lag
//! marker, every emitted event round-trips through the wire encoding) held —
//! proven simply by the process exiting successfully. No timing thresholds.

use std::process::Command;

use serde_json::Value;

fn run_live_bench(notes: usize, repeats: usize) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_vault-live-bench"))
        .args([
            "--notes",
            &notes.to_string(),
            "--repeats",
            &repeats.to_string(),
        ])
        .output()
        .expect("run vault-live-bench");
    assert!(
        output.status.success(),
        "vault-live-bench exited with {:?}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("vault-live-bench stdout is valid JSON")
}

fn case<'a>(report: &'a Value, name: &str) -> &'a Value {
    report["cases"]
        .as_array()
        .expect("cases is an array")
        .iter()
        .find(|entry| entry["case"] == name)
        .unwrap_or_else(|| panic!("no case named {name:?} in the report"))
}

#[test]
fn every_named_runtime_case_is_present_with_the_documented_shape() {
    let report = run_live_bench(25, 2);
    assert_eq!(report["schema"], 1);
    assert_eq!(report["notes"], 25);
    assert_eq!(report["repeats"], 2);

    let expected_cases = [
        "hint_to_committed_event",
        "post_edit_cached_read",
        "cached_read_availability",
        "startup_catch_up",
        "subscriber_delivery",
        "lag_recovery",
        "attachment_burst_500",
        "attachment_burst_500_new_folder",
    ];
    let cases = report["cases"].as_array().expect("cases array");
    assert_eq!(
        cases.len(),
        expected_cases.len(),
        "unexpected cases: {cases:#?}"
    );
    for name in expected_cases {
        let entry = case(&report, name);
        assert!(
            entry["timings_ms"]["p50"].is_number(),
            "case {name} must report a numeric p50"
        );
        assert!(
            !entry["timings_ms"]["samples"]
                .as_array()
                .expect("samples array")
                .is_empty(),
            "case {name} must report at least one sample"
        );
        let peak_rss = &entry["peak_rss_bytes"];
        assert!(
            peak_rss.is_null() || peak_rss.as_u64().is_some_and(|value| value > 0),
            "case {name} peak_rss_bytes must be null or a positive integer, got {peak_rss}"
        );
    }
}

#[test]
fn hint_to_event_and_cached_read_reflect_the_configured_note_count() {
    let report = run_live_bench(25, 2);
    assert_eq!(case(&report, "hint_to_committed_event")["notes"], 25);
    assert_eq!(case(&report, "post_edit_cached_read")["notes"], 25);
    assert_eq!(case(&report, "cached_read_availability")["notes"], 25);
    assert_eq!(case(&report, "startup_catch_up")["notes"], 25);
}

#[test]
fn subscriber_delivery_produces_exactly_one_event_per_notice() {
    let report = run_live_bench(25, 2);
    let entry = case(&report, "subscriber_delivery");
    // Repurposed fields (documented on `CaseReport` and in the performance
    // report): `notes` is repeats/notices offered, `affected_references` is
    // events delivered. One notice, each carrying one modified path, always
    // yields exactly one `generation_committed` event.
    assert_eq!(entry["notes"], 2);
    assert_eq!(entry["affected_references"], 2);
}

/// A folder that appears is a structural watcher event, so an import into a
/// *new* folder is answered by a whole-vault reconciliation on every repeat —
/// the claim `docs/performance/structural-parse-baseline.md` rests on, and the
/// reason the two burst cases exist separately. The case repurposes
/// `work.queue_len_before_drain` as "repeats answered by an overflow", exactly
/// as `lag_recovery` repurposes it for queue depth.
///
/// The mirror claim for `attachment_burst_500` (an import into an *existing*
/// folder stays a targeted refresh) is deliberately not asserted here: it is a
/// racing negative — a late resync from the folder's own creation could
/// legitimately answer the burst — and a benchmark smoke test is the wrong
/// place to make timing a pass/fail.
#[test]
fn a_new_folder_import_is_answered_by_a_whole_vault_reconciliation() {
    let report = run_live_bench(25, 2);
    let entry = case(&report, "attachment_burst_500_new_folder");
    let samples = entry["timings_ms"]["samples"]
        .as_array()
        .expect("samples array")
        .len() as u64;
    assert_eq!(
        entry["work"]["queue_len_before_drain"]
            .as_u64()
            .expect("queue_len_before_drain is a number"),
        samples,
        "every new-folder import repeat must take the overflow route"
    );
}

#[test]
fn lag_recovery_collapses_within_its_documented_bounds() {
    let report = run_live_bench(25, 2);
    let entry = case(&report, "lag_recovery");
    let offered = entry["notes"].as_u64().expect("notes is a number");
    assert!(
        offered > 64,
        "the case must offer past SUBSCRIBER_CAPACITY, got {offered}"
    );
    let queue_len_before_drain = entry["work"]["queue_len_before_drain"]
        .as_u64()
        .expect("queue_len_before_drain is a number");
    assert!(
        queue_len_before_drain <= 64,
        "a subscriber queue must never exceed SUBSCRIBER_CAPACITY (64), got \
         {queue_len_before_drain}"
    );
    let emitted = entry["affected_references"]
        .as_u64()
        .expect("affected_references is a number");
    assert!(
        emitted <= 2,
        "a collapsed drain must emit at most a state event plus one lag marker, got {emitted}"
    );
}
