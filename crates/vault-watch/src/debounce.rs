//! Bounded debounce and overflow latching for filesystem change signals.
//!
//! `Debouncer` never grows without bound: paths are capped at
//! `max_dirty_paths` and collapse into a single `Overflow` hint rather than
//! an ever-larger set. It never sleeps or reads a clock itself — every
//! method takes the current `Instant` explicitly so it can be driven with a
//! synthetic clock in tests.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use vault_core::VaultPath;

use crate::ChangeHint;

/// Coalesces filesystem change signals into a single [`ChangeHint`] once no
/// new activity has arrived for the configured debounce window.
///
/// Priority when multiple kinds of pending state are ready at once (highest
/// first): root invalidation, watcher failure, overflow, then paths. A root
/// invalidation means the whole watch is suspect, which matters more than
/// any path detail; a watcher failure means the OS-level watch itself is
/// unreliable; an overflow means path detail was already discarded.
#[derive(Debug)]
pub struct Debouncer {
    debounce: Duration,
    max_dirty_paths: usize,
    dirty: BTreeSet<VaultPath>,
    last_activity: Option<Instant>,
    overflowed: bool,
    root_invalidated: bool,
    watcher_failed: Option<String>,
}

impl Debouncer {
    pub fn new(debounce: Duration, max_dirty_paths: usize) -> Self {
        Self {
            debounce,
            max_dirty_paths,
            dirty: BTreeSet::new(),
            last_activity: None,
            overflowed: false,
            root_invalidated: false,
            watcher_failed: None,
        }
    }

    /// Record a single changed path. Duplicate paths are inserted once.
    /// While already overflowed, detailed paths are ignored until the
    /// overflow hint is consumed.
    pub fn observe_path(&mut self, path: VaultPath, now: Instant) {
        self.last_activity = Some(now);
        if self.overflowed {
            return;
        }
        self.dirty.insert(path);
        if self.dirty.len() > self.max_dirty_paths {
            self.dirty.clear();
            self.overflowed = true;
        }
    }

    /// Record that detail was already lost upstream (e.g. the watcher
    /// callback's own channel was full) — equivalent to exceeding
    /// `max_dirty_paths`.
    pub fn observe_overflow(&mut self, now: Instant) {
        self.last_activity = Some(now);
        self.dirty.clear();
        self.overflowed = true;
    }

    /// Record that the watched root itself was removed or renamed away.
    pub fn observe_root_invalidated(&mut self, now: Instant) {
        self.last_activity = Some(now);
        self.root_invalidated = true;
    }

    /// Record a backend watcher failure. Only the latest message is kept —
    /// failures never accumulate into an unbounded string.
    pub fn observe_watcher_failed(&mut self, message: String, now: Instant) {
        self.last_activity = Some(now);
        self.watcher_failed = Some(message);
    }

    /// Returns a ready hint once `now` is at least `debounce` past the last
    /// observed activity. Returns `None` while idle or still within the
    /// debounce window.
    pub fn poll(&mut self, now: Instant) -> Option<ChangeHint> {
        let last_activity = self.last_activity?;
        if now.saturating_duration_since(last_activity) < self.debounce {
            return None;
        }
        self.emit_ready()
    }

    fn emit_ready(&mut self) -> Option<ChangeHint> {
        if self.root_invalidated {
            self.reset();
            return Some(ChangeHint::RootInvalidated);
        }
        if let Some(message) = self.watcher_failed.take() {
            self.reset();
            return Some(ChangeHint::WatcherFailed(message));
        }
        if self.overflowed {
            self.reset();
            return Some(ChangeHint::Overflow);
        }
        if self.dirty.is_empty() {
            self.last_activity = None;
            return None;
        }
        let paths = std::mem::take(&mut self.dirty);
        self.last_activity = None;
        Some(ChangeHint::Paths(paths))
    }

    fn reset(&mut self) {
        self.dirty.clear();
        self.overflowed = false;
        self.root_invalidated = false;
        self.watcher_failed = None;
        self.last_activity = None;
    }
}
