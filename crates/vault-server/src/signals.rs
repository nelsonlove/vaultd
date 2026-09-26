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
//! [`SignalWatch::cancel`] writes the same byte from ordinary code, so the
//! service can stop for its own reasons (its last connection closed, say) and
//! still join the waiting thread rather than leaking it.

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
            return Err(SignalError::Install(std::io::Error::last_os_error()));
        }
    }
    Ok(SignalWatch { read })
}

impl SignalWatch {
    /// Block until a signal arrives or [`SignalWatch::cancel`] is called.
    /// `None` means it was cancelled; `Some(signal)` names what arrived.
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

    /// Unblock a waiter without a signal, so the service can stop for its own
    /// reasons and still join the watcher thread.
    pub fn cancel(&self) {
        let descriptor = PIPE_WRITE.load(Ordering::Acquire);
        if descriptor >= 0 {
            let byte: u8 = 0;
            // SAFETY: the same one-byte write the handler performs.
            unsafe {
                libc::write(descriptor, std::ptr::addr_of!(byte).cast(), 1);
            }
        }
    }
}
