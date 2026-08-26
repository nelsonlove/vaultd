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
/// new activity has arrived for the configured debounce window — or once
/// `max_debounce` has elapsed since the first unconsumed signal, whichever
/// comes first.
///
/// The `max_debounce` bound exists because `debounce` alone can starve
/// forever under sustained churn: if activity keeps arriving faster than
/// `debounce`, `last_activity` keeps sliding and the per-activity window
/// never elapses. `first_activity` anchors to the start of the current
/// unconsumed streak (any signal — path, overflow, root, failure — extends
/// `last_activity` but never moves `first_activity` back once set), so a
/// hint is always guaranteed to escape within `max_debounce` regardless of
/// how continuous the storm is.
///
/// Priority when multiple kinds of pending state are ready at once (highest
/// first): root invalidation, watcher failure, overflow, then paths. A root
/// invalidation means the whole watch is suspect, which matters more than
/// any path detail; a watcher failure means the OS-level watch itself is
/// unreliable; an overflow means path detail was already discarded.
#[derive(Debug)]
pub struct Debouncer {
    debounce: Duration,
    max_debounce: Duration,
    max_dirty_paths: usize,
    dirty: BTreeSet<VaultPath>,
    first_activity: Option<Instant>,
    last_activity: Option<Instant>,
    overflowed: bool,
    root_invalidated: bool,
    watcher_failed: Option<String>,
}

impl Debouncer {
    pub fn new(debounce: Duration, max_debounce: Duration, max_dirty_paths: usize) -> Self {
        Self {
            debounce,
            max_debounce,
            max_dirty_paths,
            dirty: BTreeSet::new(),
            first_activity: None,
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
        self.touch(now);
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
    /// callback's own channel was full, or the kernel told us to rescan) —
    /// equivalent to exceeding `max_dirty_paths`.
    pub fn observe_overflow(&mut self, now: Instant) {
        self.touch(now);
        self.dirty.clear();
        self.overflowed = true;
    }

    /// Record that the watched root itself was removed or renamed away.
    pub fn observe_root_invalidated(&mut self, now: Instant) {
        self.touch(now);
        self.root_invalidated = true;
    }

    /// Record a backend watcher failure. Only the latest message is kept —
    /// failures never accumulate into an unbounded string.
    pub fn observe_watcher_failed(&mut self, message: String, now: Instant) {
        self.touch(now);
        self.watcher_failed = Some(message);
    }

    /// Refresh `last_activity` and anchor `first_activity` the first time
    /// it's called since the last emitted (or never-started) window.
    fn touch(&mut self, now: Instant) {
        if self.first_activity.is_none() {
            self.first_activity = Some(now);
        }
        self.last_activity = Some(now);
    }

    /// Returns a ready hint once `now` is at least `debounce` past the last
    /// observed activity, or at least `max_debounce` past the first
    /// unconsumed activity — whichever comes first. Returns `None` while
    /// idle or still inside both windows.
    pub fn poll(&mut self, now: Instant) -> Option<ChangeHint> {
        let last_activity = self.last_activity?;
        let first_activity = self.first_activity.unwrap_or(last_activity);
        let debounce_elapsed = now.saturating_duration_since(last_activity) >= self.debounce;
        let max_elapsed = now.saturating_duration_since(first_activity) >= self.max_debounce;
        if !debounce_elapsed && !max_elapsed {
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
            self.reset();
            return None;
        }
        let paths = std::mem::take(&mut self.dirty);
        self.reset();
        Some(ChangeHint::Paths(paths))
    }

    fn reset(&mut self) {
        self.dirty.clear();
        self.overflowed = false;
        self.root_invalidated = false;
        self.watcher_failed = None;
        self.first_activity = None;
        self.last_activity = None;
    }
}
