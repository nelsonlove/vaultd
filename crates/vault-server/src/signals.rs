//! SIGTERM and SIGINT, turned into something a thread can wait on.
//!
//! A signal handler may call only async-signal-safe functions, which rules out
//! locking, allocating, and every channel this daemon uses. The standard
//! answer is the self-pipe: the handler does one `write(2)` of one byte, which
//! is async-signal-safe, and an ordinary thread blocks in `read(2)` on the
//! other end. Everything that must actually happen — telling each connection,
//! draining, unlinking — then happens on that ordinary thread with the whole
//! language available.
//!
//! **A second signal during the stop is inert, and that is the policy.** The
//! watcher reads one byte and is done: the read end of the self-pipe is
//! dropped the moment [`SignalWatch::wait`] returns, so a second SIGTERM or
//! SIGINT arriving while the daemon is draining writes to a pipe nobody is
//! reading and is discarded. An operator's second Ctrl-C therefore does not
//! hurry the exit. It does not need to: the stop is bounded at two drain
//! budgets, ten seconds, and nothing in it can hang. The escalation for a
//! daemon that must go *now* is SIGKILL, which no handler can intercept and
//! which the bounded stop makes unnecessary in every case but a kernel-level
//! wedge.
//!
//! **Handlers are installed before the runtime is built and before the socket
//! is bound** (see `main::run`), so a stop arriving during cold hydration or
//! in the window between binding and serving is still a clean stop rather
//! than the default disposition killing the process with its socket file
//! already on disk. They are installed **only** when the daemon is going to
//! listen: without `--listen` there is nothing to wait on the flag, and
//! swallowing SIGTERM there would leave a stdio-only daemon that cannot be
//! stopped by anything but SIGKILL.

use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

/// The write end of the self-pipe, as a raw descriptor, because a signal
/// handler can touch nothing richer than this.
static PIPE_WRITE: AtomicI32 = AtomicI32::new(-1);
/// The signal that arrived, for the report. `0` means "cancelled".
static SIGNAL: AtomicI32 = AtomicI32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, thiserror::Error)]
pub enum SignalError {
    #[error("signal handlers are already installed in this process")]
    AlreadyInstalled,
    #[error("cannot install signal handlers: {0}")]
    Install(#[from] std::io::Error),
}

pub struct SignalWatch {
    read: OwnedFd,
}

extern "C" fn handle(signal: i32) {
    // Only async-signal-safe calls below: one relaxed atomic store and one
    // `write`. The byte's value is never read — its arrival is the message.
    SIGNAL.store(signal, Ordering::Relaxed);
    let descriptor = PIPE_WRITE.load(Ordering::Relaxed);
    if descriptor >= 0 {
        let byte: u8 = 1;
        // SAFETY: a one-byte write to a descriptor this process owns for the
        // life of the program. The result is deliberately ignored: a full pipe
        // means a stop is already pending, which is the same outcome.
        unsafe {
            libc::write(descriptor, std::ptr::addr_of!(byte).cast(), 1);
        }
    }
}

/// Install handlers for SIGTERM and SIGINT. Once per process.
///
/// Returns the read end of the self-pipe; the caller blocks a thread on
/// [`SignalWatch::wait`] and treats any return as "stop". Installing twice in
/// one process is a programming error and answers
/// [`SignalError::AlreadyInstalled`].
pub fn install() -> Result<SignalWatch, SignalError> {
    if INSTALLED.swap(true, Ordering::AcqRel) {
        return Err(SignalError::AlreadyInstalled);
    }
    let mut ends = [0 as libc::c_int; 2];
    // SAFETY: `pipe` fills the two-element array it is given.
    if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
        // The latch is released on every failure, or a caller that retried
        // would be told "already installed" for ever and never learn what
        // actually went wrong.
        INSTALLED.store(false, Ordering::Release);
        return Err(SignalError::Install(std::io::Error::last_os_error()));
    }
    // SAFETY: both descriptors were just created by `pipe` and are unowned.
    let read = unsafe { OwnedFd::from_raw_fd(ends[0]) };
    PIPE_WRITE.store(ends[1], Ordering::Release);
    for signal in [libc::SIGTERM, libc::SIGINT] {
        // The cast goes through a pointer rather than straight to the
        // integer `sighandler_t` is, which is what `signal(2)` wants and what
        // the compiler asks for.
        let handler = handle as *const () as libc::sighandler_t;
        // SAFETY: `handle` touches only the two atomics above and `write`.
        if unsafe { libc::signal(signal, handler) } == libc::SIG_ERR {
            INSTALLED.store(false, Ordering::Release);
            return Err(SignalError::Install(std::io::Error::last_os_error()));
        }
    }
    Ok(SignalWatch { read })
}

impl SignalWatch {
    /// Block until a signal arrives. `Some(signal)` names what arrived;
    /// `None` means the self-pipe could not be read, which is not a case any
    /// caller can do anything about beyond stopping, and is treated as a stop.
    ///
    /// The brief's interface also had a `cancel`, for a service that stopped
    /// for its own reasons and wanted to join this thread rather than leak
    /// it. Nothing stops for its own reasons: the accept loop's return is the
    /// only way out, and `run` drops the watcher handle rather than joining
    /// it. It is left out rather than left uncalled — an unused waking
    /// mechanism that writes to a process-wide descriptor and does not clear
    /// [`SIGNAL`] is a thing to get wrong later, not an asset.
    pub fn wait(&self) -> Option<i32> {
        let mut byte = [0u8; 1];
        loop {
            // SAFETY: a one-byte read from a descriptor this struct owns.
            let read = unsafe { libc::read(self.read.as_raw_fd(), byte.as_mut_ptr().cast(), 1) };
            if read == 1 {
                break;
            }
            if read < 0 {
                let error = std::io::Error::last_os_error();
                // A signal interrupting the read is exactly the case this
                // loop exists for.
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
            }
            return None;
        }
        match SIGNAL.load(Ordering::Relaxed) {
            0 => None,
            signal => Some(signal),
        }
    }
}
