//! Wires up the `notify` watcher backend behind a nonblocking, bounded
//! channel. Watcher callbacks never block, never read files, and never
//! accumulate unbounded state: a full channel just flips an overflow latch
//! for the consumer to notice on its own schedule.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::WatchError;

pub(crate) type RawEvent = notify::Result<notify::Event>;

pub(crate) struct Backend {
    pub(crate) watcher: RecommendedWatcher,
    pub(crate) events: Receiver<RawEvent>,
    pub(crate) overflow_latch: Arc<AtomicBool>,
}

pub(crate) fn start(canonical_root: &Path, callback_queue: usize) -> Result<Backend, WatchError> {
    let (callback_tx, callback_rx) = mpsc::sync_channel::<RawEvent>(callback_queue.max(1));
    let overflow_latch = Arc::new(AtomicBool::new(false));
    let latch_for_callback = Arc::clone(&overflow_latch);

    let mut watcher = notify::recommended_watcher(move |result: RawEvent| {
        if callback_tx.try_send(result).is_err() {
            latch_for_callback.store(true, Ordering::Release);
        }
    })
    .map_err(|error| WatchError::Init(error.to_string()))?;

    watcher
        .watch(canonical_root, RecursiveMode::Recursive)
        .map_err(|error| WatchError::Init(error.to_string()))?;

    Ok(Backend {
        watcher,
        events: callback_rx,
        overflow_latch,
    })
}
