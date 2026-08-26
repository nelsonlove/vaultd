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

impl WorkCounts {
    /// Fold one delta publication's write counts into the same counters the
    /// full-publication path populates (`note_rows_written`,
    /// `reference_rows_written`, `resolution_rows_written`,
    /// `dependency_rows_written`, `diagnostic_rows_written`), so a caller on
    /// the incremental path can report the identical `WorkCounts` shape a
    /// full publication would, regardless of which path produced a
    /// generation. This only adds onto whatever is already present — the
    /// full-publication path keeps populating these same fields
    /// independently, so its own totals remain available for a
    /// fallback/benchmark comparison against the delta path.
    pub fn merge_delta(&mut self, delta: &crate::store::DeltaWriteCounts) {
        self.note_rows_written += delta.notes_replaced;
        self.reference_rows_written += delta.references_replaced;
        self.resolution_rows_written += delta.resolutions_replaced;
        self.dependency_rows_written += delta.dependencies_replaced;
        self.diagnostic_rows_written += delta.diagnostics_replaced;
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReconcileMetrics {
    pub stages: StageDurations,
    pub work: WorkCounts,
}

#[cfg(test)]
mod tests {
    use super::WorkCounts;
    use crate::store::DeltaWriteCounts;

    /// Merging a delta's write counts must add onto whatever the
    /// full-publication path already populated, never reset or replace it —
    /// the full-publication counters stay available for a fallback/benchmark
    /// comparison against the delta path.
    #[test]
    fn merge_delta_adds_onto_existing_full_publication_counters() {
        let mut work = WorkCounts {
            note_rows_written: 2,
            reference_rows_written: 3,
            resolution_rows_written: 4,
            dependency_rows_written: 5,
            diagnostic_rows_written: 6,
            ..WorkCounts::default()
        };
        let delta = DeltaWriteCounts {
            notes_replaced: 1,
            notes_deleted: 0,
            fingerprints_updated: 0,
            references_replaced: 1,
            resolutions_replaced: 1,
            dependencies_replaced: 2,
            diagnostics_replaced: 1,
            unaffected_references_touched: 0,
        };

        work.merge_delta(&delta);

        assert_eq!(work.note_rows_written, 3);
        assert_eq!(work.reference_rows_written, 4);
        assert_eq!(work.resolution_rows_written, 5);
        assert_eq!(work.dependency_rows_written, 7);
        assert_eq!(work.diagnostic_rows_written, 7);
    }
}
