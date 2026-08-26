//! Smoke tests for `vault-bench --live`: a small, fast run
//! (`--notes 25 --repeats 2`) that asserts the JSON schema, the named
//! live-incremental cases are all present, their structural counters prove
//! what each case claims to exercise, and `peak_rss_bytes` is populated —
//! with no timing thresholds anywhere, per the design's "release baselines,
//! not brittle CI assertions" rule.

use std::process::Command;

use serde_json::Value;

fn run_live_bench(notes: usize, repeats: usize) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_vault-bench"))
        .args([
            "--notes",
            &notes.to_string(),
            "--repeats",
            &repeats.to_string(),
            "--live",
        ])
        .output()
        .expect("run vault-bench");
    assert!(
        output.status.success(),
        "vault-bench exited with {:?}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("vault-bench stdout is valid JSON")
}

fn case<'a>(report: &'a Value, name: &str) -> &'a Value {
    report["live_cases"]
        .as_array()
        .expect("live_cases is an array")
        .iter()
        .find(|entry| entry["case"] == name)
        .unwrap_or_else(|| panic!("no case named {name:?} in the report"))
}

#[test]
fn live_cases_cover_every_named_case_with_the_documented_shape() {
    let report = run_live_bench(25, 2);

    assert_eq!(report["schema"], 1);
    assert_eq!(report["mode"], "synthetic");

    let expected_cases = [
        "body_only_edit",
        "outgoing_reference_edit",
        "heading_fanout_0",
        "heading_fanout_10",
        "heading_fanout_100",
        "heading_fanout_high",
        "unresolved_to_resolved",
        "resolved_to_ambiguous",
        "delete_reversals",
        "rename",
        "burst_100_notes",
        "complete_fallback_after_overflow",
        "compact_graph_hydration",
    ];
    let live_cases = report["live_cases"].as_array().expect("live_cases array");
    assert_eq!(
        live_cases.len(),
        expected_cases.len(),
        "unexpected case count: {live_cases:#?}"
    );
    for name in expected_cases {
        let entry = case(&report, name);
        assert_eq!(entry["notes"], 25, "case {name} notes field");
        let stages = &entry["stages_ms"];
        for field in [
            "inventory",
            "body_read",
            "parse",
            "impact_planning",
            "resolution",
            "candidate_build",
            "sqlite_write",
            "sqlite_commit",
            "live_install",
            "event_enqueue",
        ] {
            let distribution = &stages[field];
            assert!(
                distribution["p50"].is_number(),
                "case {name} stage {field} p50 must be a number"
            );
            assert!(
                distribution["p95"].is_number(),
                "case {name} stage {field} p95 must be a number"
            );
            assert!(
                distribution["samples"].is_array(),
                "case {name} stage {field} samples must be an array"
            );
        }
        let peak_rss = &entry["peak_rss_bytes"];
        assert!(
            peak_rss.is_null() || peak_rss.as_u64().is_some_and(|value| value > 0),
            "case {name} peak_rss_bytes must be null or a positive integer, got {peak_rss}"
        );
    }
}

#[test]
fn heading_fanout_affected_references_match_the_named_fan_out() {
    let report = run_live_bench(25, 2);
    assert_eq!(case(&report, "heading_fanout_0")["affected_references"], 0);
    assert_eq!(
        case(&report, "heading_fanout_10")["affected_references"],
        10
    );
    assert_eq!(
        case(&report, "heading_fanout_100")["affected_references"],
        100
    );
    assert_eq!(
        case(&report, "heading_fanout_high")["affected_references"],
        1_000
    );
}

#[test]
fn zero_fan_in_and_outgoing_edits_touch_exactly_what_they_claim() {
    let report = run_live_bench(25, 2);
    assert_eq!(case(&report, "body_only_edit")["affected_references"], 0);
    assert_eq!(
        case(&report, "outgoing_reference_edit")["affected_references"],
        1
    );
}

#[test]
fn the_forced_threshold_case_reaches_the_complete_resolution_fallback() {
    let report = run_live_bench(25, 2);
    let entry = case(&report, "complete_fallback_after_overflow");
    // `affected_references` is the last sample's re-resolved count under a
    // forced threshold of 1: every reference the compact graph holds, which
    // is strictly more than the 10-note heading fan-out alone selects.
    let affected = entry["affected_references"]
        .as_u64()
        .expect("affected_references is a number");
    assert!(
        affected > 10,
        "a forced complete-resolution fallback must re-resolve the whole graph, not just the \
         selected fan-out, got {affected}"
    );
}

#[test]
fn compact_graph_hydration_reports_the_full_reference_count() {
    let report = run_live_bench(25, 2);
    let entry = case(&report, "compact_graph_hydration");
    let affected = entry["affected_references"]
        .as_u64()
        .expect("affected_references is a number");
    assert!(
        affected > 0,
        "hydrating a non-empty compact graph must report a positive reference count"
    );
}

#[test]
fn live_flag_is_a_no_op_without_it() {
    let report = run_live_bench_without_live(10, 2);
    assert_eq!(
        report["live_cases"]
            .as_array()
            .expect("live_cases array")
            .len(),
        0,
        "live_cases must stay empty when --live was not passed"
    );
}

fn run_live_bench_without_live(notes: usize, repeats: usize) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_vault-bench"))
        .args([
            "--notes",
            &notes.to_string(),
            "--repeats",
            &repeats.to_string(),
        ])
        .output()
        .expect("run vault-bench");
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).expect("vault-bench stdout is valid JSON")
}
