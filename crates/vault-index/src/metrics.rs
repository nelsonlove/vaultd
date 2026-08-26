//! Structural instrumentation for one reconciliation attempt.
//!
//! `ReconcileMetrics` is the single, reusable shape for every reconciliation
//! stage timing and structural work counter. Later phases extend the same
//! struct (populating stages/counters this phase leaves at zero) rather than
//! introducing a second metrics type.

use std::time::Duration;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StageDurations {
    pub inventory: Duration,
    pub body_read: Duration,
    pub parse: Duration,
    pub impact_planning: Duration,
    pub resolution: Duration,
    pub candidate_build: Duration,
    pub sqlite_write: Duration,
    pub sqlite_commit: Duration,
    pub live_install: Duration,
    pub event_enqueue: Duration,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WorkCounts {
    pub complete_inventories: u64,
    pub body_reads: u64,
    pub notes_reparsed: u64,
    pub changed_notes: u64,
    /// References selected for re-resolution this cycle: outgoing-only on
    /// the complete-resolution path; outgoing plus dependency-selected
    /// incoming references on the live (incremental) path.
    pub affected_references: u64,
    pub references_resolved: u64,
    pub note_rows_written: u64,
    pub reference_rows_written: u64,
    pub resolution_rows_written: u64,
    pub dependency_rows_written: u64,
    pub diagnostic_rows_written: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReconcileMetrics {
    pub stages: StageDurations,
    pub work: WorkCounts,
}
