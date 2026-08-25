use std::process::Command;

#[test]
fn benchmark_emits_machine_readable_metrics() {
    let output = Command::new(env!("CARGO_BIN_EXE_vault-bench"))
        .args(["--notes", "100", "--repeats", "2"])
        .output()
        .expect("run benchmark smoke test");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).expect("JSON report");

    assert_eq!(report["schema"], 1);
    assert_eq!(report["mode"], "synthetic");
    assert_eq!(report["note_count"], 100);
    for metric in [
        "cold_index",
        "warm_startup",
        "one_file_refresh",
        "verified_refresh",
        "get_note",
        "backlinks",
        "list_100",
    ] {
        assert!(report["timings_ms"][metric]["p50"].is_number(), "{metric}");
        assert!(report["timings_ms"][metric]["p95"].is_number(), "{metric}");
    }
    assert_eq!(report["work"]["warm_startup_body_reads"], 0);
    assert_eq!(report["work"]["warm_startup_reparsed"], 0);
}
