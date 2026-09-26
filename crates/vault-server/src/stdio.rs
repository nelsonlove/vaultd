//! The stdio transport: connection zero.
//!
//! Since the socket transport landed, the loop itself lives in
//! [`crate::connection`] and this module is the one call that runs it over the
//! process's own standard input and output. Nothing about stdio is special: it
//! is a connection like any other, it is closed when stdin closes, and it is
//! absent when the daemon is started with stdin closed.
//!
//! What is special is who ends the runtime. Without `--listen` there is
//! nothing else serving, so the end of stdin is the end of the daemon and this
//! module's `after_dispatch` stops the runtime — which is also what lets the
//! notice forwarder finish, because stopping the runtime drops the
//! coordinator's notice sender. With `--listen`, [`crate::service`] serves
//! connection zero instead and the end of stdin ends that connection alone.

use std::io;
use std::sync::mpsc::Receiver;

use crate::Server;
use crate::broadcast::ConnectionId;
use crate::connection::{self, ThreadLabels};
use crate::runtime::RuntimeNotice;

/// Serve the stdio loop until stdin closes, input becomes unparseable, or the
/// writer fails. Always shuts the runtime down and joins every thread before
/// returning.
///
/// The handles are passed unlocked. `connection::serve` moves them into the
/// threads it spawns, so they must be `Send`, and a `StdinLock`/`StdoutLock`
/// guard is not — the loop this replaced locked inside each thread instead.
/// `Stdin` and `Stdout` are `Send + Sync` and take the same lock per call, and
/// since exactly one thread reads and one thread writes, nothing contends for
/// either: the only cost is re-acquiring an uncontended lock. `Stdin` is
/// wrapped because only its guard is a `BufRead`. The "one writer, nothing
/// tears" argument is unchanged: this process still has exactly one writer
/// thread, and it is the only code that touches stdout.
pub fn run(server: Server, notices: Option<Receiver<RuntimeNotice>>) -> Result<(), String> {
    connection::serve(
        &server,
        // No broadcaster issued an identifier here: this daemon has one
        // connection and takes the runtime's notice receiver directly.
        ConnectionId::STANDALONE,
        io::BufReader::new(io::stdin()),
        io::stdout(),
        notices,
        ThreadLabels {
            reader: "vaultd-stdin".into(),
            writer: "vaultd-stdout".into(),
            notices: "vaultd-notices".into(),
        },
        || server.shutdown(),
    )
}
