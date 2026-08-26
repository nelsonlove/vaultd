//! Bounded, normalized filesystem change hints for an Obsidian-compatible
//! vault. `vault-watch` knows nothing about the SQLite cache, the wire
//! protocol, or the server process — it only turns raw filesystem events
//! into a small, bounded stream of [`ChangeHint`] values keyed by
//! [`vault_core::VaultPath`].

mod backend;
mod debounce;
mod filter;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use thiserror::Error;

pub use debounce::Debouncer;
pub use filter::normalize_included_markdown;

/// A single, normalized signal about vault content that may have changed.
///
/// `Paths` is always non-empty and bounded by [`WatchConfig::max_dirty_paths`].
/// Everything else is a fallback that tells the consumer detail was lost or
/// unreliable and it must fall back to full reconciliation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChangeHint {
    Paths(BTreeSet<vault_core::VaultPath>),
    Overflow,
    RootInvalidated,
    WatcherFailed(String),
}

/// Tuning knobs for the watcher's debounce window and bounded buffers.
#[derive(Clone, Debug)]
pub struct WatchConfig {
    pub debounce: Duration,
    /// Hard ceiling on how long a pending hint may be held back, measured
    /// from the *first* unconsumed signal rather than the most recent one.
    /// Sustained churn (writes arriving faster than `debounce`) would
    /// otherwise reset the debounce window forever and never emit — this
    /// bound guarantees a hint eventually escapes. Defaults to 10x the
    /// default `debounce` (1s), a round number well above normal editor
    /// save latency but short enough that a storm is still noticed quickly.
    pub max_debounce: Duration,
    pub max_dirty_paths: usize,
    pub callback_queue: usize,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            debounce: Duration::from_millis(100),
            max_debounce: Duration::from_millis(1_000),
            max_dirty_paths: 8_192,
            callback_queue: 1_024,
        }
    }
}

/// Errors starting or reading from a [`WatchStream`].
#[derive(Debug, Error)]
pub enum WatchError {
    #[error("failed to start filesystem watcher: {0}")]
    Init(String),
    #[error("filesystem watcher channel closed unexpectedly")]
    Closed,
    #[error("path is not valid utf-8: {0}")]
    InvalidPath(String),
}

/// A live handle on a filesystem watch rooted at a vault directory.
///
/// Owns the underlying `notify` watcher; dropping `WatchStream` stops
/// watching and releases the watcher's sender.
pub struct WatchStream {
    _watcher: notify::RecommendedWatcher,
    events: std::sync::mpsc::Receiver<notify::Result<notify::Event>>,
    overflow_latch: std::sync::Arc<std::sync::atomic::AtomicBool>,
    canonical_root: PathBuf,
    debouncer: Debouncer,
}

impl WatchStream {
    /// Start watching `root` recursively. `root` is canonicalized once at
    /// start; the watch tracks that canonical path for the lifetime of the
    /// stream.
    pub fn start(root: impl AsRef<Path>, config: WatchConfig) -> Result<Self, WatchError> {
        let canonical_root = root
            .as_ref()
            .canonicalize()
            .map_err(|error| WatchError::Init(format!("{}: {error}", root.as_ref().display())))?;
        if !canonical_root.is_dir() {
            return Err(WatchError::Init(format!(
                "{} is not a directory",
                canonical_root.display()
            )));
        }

        let backend = backend::start(&canonical_root, config.callback_queue)?;

        Ok(Self {
            _watcher: backend.watcher,
            events: backend.events,
            overflow_latch: backend.overflow_latch,
            canonical_root,
            debouncer: Debouncer::new(config.debounce, config.max_debounce, config.max_dirty_paths),
        })
    }

    /// Block for up to `timeout` waiting for a debounced hint. Returns
    /// `Ok(None)` on timeout with nothing ready — callers should call again.
    pub fn recv_timeout(&mut self, timeout: Duration) -> Result<Option<ChangeHint>, WatchError> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.overflow_latch.swap(false, Ordering::Acquire) {
                self.debouncer.observe_overflow(Instant::now());
            }
            if let Some(hint) = self.debouncer.poll(Instant::now()) {
                return Ok(Some(hint));
            }

            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            let remaining = deadline - now;
            let slice = remaining.min(Duration::from_millis(20));

            match self.events.recv_timeout(slice) {
                Ok(Ok(event)) => self.handle_event(event, Instant::now()),
                Ok(Err(error)) => self
                    .debouncer
                    .observe_watcher_failed(error.to_string(), Instant::now()),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Err(WatchError::Closed),
            }
        }
    }

    fn handle_event(&mut self, event: notify::Event, now: Instant) {
        use notify::EventKind;
        use notify::event::{CreateKind, ModifyKind, RemoveKind};

        // The kernel (or notify itself) is telling us events were dropped
        // or coalesced and our view of the tree can no longer be trusted
        // incrementally. This outranks every other kind check below —
        // notify sets it on `EventKind::Other`, which the access/other
        // early-return further down would otherwise silently swallow.
        if event.need_rescan() {
            self.debouncer.observe_overflow(now);
            return;
        }

        let root_affected = matches!(
            event.kind,
            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
        ) && event.paths.iter().any(|path| path == &self.canonical_root);
        if root_affected {
            self.debouncer.observe_root_invalidated(now);
            return;
        }

        if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
            return;
        }

        let mut any_included = false;
        for path in &event.paths {
            if let Ok(Some(vault_path)) =
                filter::normalize_included_markdown(&self.canonical_root, path)
            {
                self.debouncer.observe_path(vault_path, now);
                any_included = true;
            }
        }

        // A folder create/remove/rename never itself normalizes to an
        // included `.md` path (directories have no extension), so the loop
        // above never sees it — yet the descendants that moved with it can
        // include notes the incremental hint has no way to name. Renaming
        // `Folder/` to `Renamed/` is a routine Obsidian drag-and-drop; it
        // must never come back as zero hints. Force a reconcile instead of
        // guessing which paths changed.
        let structural_without_detail = !any_included
            && matches!(
                event.kind,
                EventKind::Create(CreateKind::Folder)
                    | EventKind::Remove(RemoveKind::Folder)
                    | EventKind::Modify(ModifyKind::Name(_))
            );
        if structural_without_detail {
            self.debouncer.observe_overflow(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use tempfile::TempDir;

    use super::{ChangeHint, WatchConfig, WatchStream};

    /// The consumer runs an `IndexService` (Send but not Sync) on a single
    /// writer thread and needs to move a `WatchStream` there. This is a
    /// compile-time check, not a runtime assertion.
    fn assert_send<T: Send>() {}

    #[test]
    fn watch_stream_is_send() {
        assert_send::<WatchStream>();
    }

    /// notify emits `Event::new(EventKind::Other).set_flag(Flag::Rescan)`
    /// for FSEvents' `kFSEventStreamEventFlagMustScanSubDirs` and inotify's
    /// `IN_Q_OVERFLOW` — the kernel telling us events were dropped. This
    /// must never be silently swallowed by the `Access | Other` early
    /// return; it has to force a full reconcile.
    #[test]
    fn kernel_rescan_signal_forces_an_overflow_hint() {
        let root = TempDir::new().expect("temp vault");
        let mut stream =
            WatchStream::start(root.path(), WatchConfig::default()).expect("start watch");
        let now = Instant::now();

        let event =
            notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan);
        stream.handle_event(event, now);

        let hint = stream
            .debouncer
            .poll(now + Duration::from_millis(100))
            .expect("ready");
        assert_eq!(hint, ChangeHint::Overflow);
    }
}
