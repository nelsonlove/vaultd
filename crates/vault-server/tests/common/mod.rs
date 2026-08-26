#![allow(dead_code)]

//! Rendezvous primitives shared by the runtime and subscription race tests.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use vault_server::runtime::{RuntimeHook, RuntimeTestHooks};

/// How long a test waits for a hook to arrive before failing by name.
const RENDEZVOUS_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a parked hook waits to be released before giving up and carrying
/// on. Only ever reached once the test has already failed, and it exists so
/// that a failing test cannot wedge the thread it was driving — a coordinator
/// hook that blocked forever would hang `shutdown`'s join and turn a named
/// assertion failure back into a silent CI timeout.
const HOOK_RELEASE_TIMEOUT: Duration = Duration::from_secs(30);

/// A one-shot, two-phase rendezvous with a **named** timeout on the test's
/// side.
///
/// A `Barrier` is the obvious tool here and the wrong one. Every hook these
/// tests park on is reached by position — "the second mutation the
/// coordinator makes" — and a position can shift: one `Busy` retry inside the
/// startup catch-up renumbers every mutation after it. With a `Barrier` that
/// shift blocks both sides forever and CI reports a timeout with no output at
/// all. Here the test fails saying exactly which rendezvous never fired, and
/// neither side can block indefinitely.
pub struct Rendezvous {
    label: &'static str,
    reached: Receiver<()>,
    release: SyncSender<()>,
}

impl Rendezvous {
    /// Block until the hook has arrived and parked.
    pub fn arrived(&self) {
        self.reached
            .recv_timeout(RENDEZVOUS_TIMEOUT)
            .unwrap_or_else(|_| {
                panic!(
                    "the {} rendezvous never fired within {RENDEZVOUS_TIMEOUT:?} — \
                     the mutation it is gated on was never reached, most likely \
                     because a retry renumbered the mutation sequence",
                    self.label
                )
            });
    }

    /// Let the parked hook continue.
    pub fn release(&self) {
        let _ = self.release.try_send(());
    }
}

/// A rendezvous and the hook that parks on it. The hook fires exactly once.
pub fn rendezvous(label: &'static str) -> (Rendezvous, RuntimeHook) {
    let (reached_tx, reached) = sync_channel(1);
    let (release, release_rx) = sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    let fired = AtomicBool::new(false);
    let hook: RuntimeHook = Arc::new(move || {
        if fired.swap(true, Ordering::SeqCst) {
            return;
        }
        // Capacity one and `try_send`, so announcing arrival can never block
        // even if the test has already given up and gone away.
        let _ = reached_tx.try_send(());
        let guard = release_rx.lock().unwrap_or_else(|error| error.into_inner());
        let _ = guard.recv_timeout(HOOK_RELEASE_TIMEOUT);
    });
    (
        Rendezvous {
            label,
            reached,
            release,
        },
        hook,
    )
}

/// Wrap `inner` so it parks on a rendezvous the `sequence`-th time it is
/// called, and runs `inner` on every call. Sequence numbers are zero-based
/// over the coordinator's own mutations: 0 is the startup catch-up.
pub fn park_at(
    label: &'static str,
    sequence: usize,
    inner: Option<RuntimeHook>,
) -> (Rendezvous, RuntimeHook) {
    let (parked, park) = rendezvous(label);
    let seen = Arc::new(AtomicUsize::new(0));
    let hook: RuntimeHook = Arc::new(move || {
        if let Some(inner) = &inner {
            inner();
        }
        if seen.fetch_add(1, Ordering::AcqRel) == sequence {
            park();
        }
    });
    (parked, hook)
}

/// Hooks that park the coordinator inside one chosen mutation. `at_exit`
/// selects which side of the call into the `IndexService` to park on: `false`
/// is immediately before it, `true` immediately after — and after a targeted
/// reconciliation that is the commit boundary itself, with the publication
/// barrier already moved and the notice not yet emitted.
pub fn park_at_mutation(
    label: &'static str,
    sequence: usize,
    at_exit: bool,
) -> (RuntimeTestHooks, Rendezvous) {
    let (parked, hook) = park_at(label, sequence, None);
    let hooks = if at_exit {
        RuntimeTestHooks {
            mutation_exit: Some(hook),
            ..RuntimeTestHooks::default()
        }
    } else {
        RuntimeTestHooks {
            mutation_enter: Some(hook),
            ..RuntimeTestHooks::default()
        }
    };
    (hooks, parked)
}
