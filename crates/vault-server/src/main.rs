use std::error::Error;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use clap::Parser;
use vault_index::IndexConfig;
use vault_server::Server;
use vault_server::runtime::{RuntimeNotice, RuntimeOptions};

#[derive(Debug, Parser)]
#[command(name = "vaultd", version, about)]
struct Cli {
    #[arg(long, value_name = "PATH")]
    vault: Option<PathBuf>,
    #[arg(long, value_name = "PATH", requires = "vault")]
    index: Option<PathBuf>,
    // The three tuning flags below describe a runtime, and `--read-only`
    // (the fourth to land) describes a restriction on one, so each requires
    // `--vault` exactly as `--index` does. Accepting them without one would
    // silently do nothing. `requires` is evaluated only for values that came
    // from the command line, so the defaults below still leave bare
    // `vaultd` valid.
    /// Reconcile on demand and on the periodic tick only, installing no
    /// filesystem watcher.
    #[arg(long, default_value_t = false, requires = "vault")]
    no_watch: bool,
    /// How long a burst of filesystem events is coalesced before it becomes
    /// one dirty batch.
    #[arg(
        long,
        default_value_t = 100,
        requires = "vault",
        value_parser = clap::value_parser!(u64).range(10..=5_000),
    )]
    watch_debounce_ms: u64,
    /// How often the vault is reconciled completely regardless of watcher
    /// activity. `0` disables the periodic tick.
    #[arg(long, default_value_t = 60, requires = "vault")]
    reconcile_interval_seconds: u64,
    /// Refuse every operation that would write into the vault. Reads,
    /// snapshot sessions, and reconciliation are unaffected.
    #[arg(long, default_value_t = false, requires = "vault")]
    read_only: bool,
    /// Also serve a Unix domain socket, so clients other than this process's
    /// parent can reach the daemon and the daemon can outlive them.
    ///
    /// With no value, the default path: `<run dir>/<digest>.sock`, where the
    /// digest is the first 16 hex characters of the SHA-256 of the canonical
    /// vault root and the run directory is `$XDG_RUNTIME_DIR/vaultd` when that
    /// is set, else `<XDG cache dir>/vaultd/run`.
    #[arg(long, value_name = "PATH", num_args = 0..=1, requires = "vault")]
    listen: Option<Option<PathBuf>>,
    /// How many evaluated views to keep for the current generation. Older
    /// generations are always dropped; this bounds one generation's worth.
    #[arg(
        long,
        default_value_t = vault_server::DEFAULT_BASE_CACHE_ENTRIES as u64,
        requires = "vault",
        value_parser = clap::value_parser!(u64).range(1..=4096),
    )]
    bases_cache_entries: u64,
    /// How many search answers to keep for the current generation. Older
    /// generations are always dropped; this bounds one generation's worth.
    #[arg(
        long,
        default_value_t = vault_server::DEFAULT_SEARCH_CACHE_ENTRIES as u64,
        requires = "vault",
        value_parser = clap::value_parser!(u64).range(1..=1024),
    )]
    search_cache_entries: u64,
}

impl Cli {
    fn runtime_options(&self) -> RuntimeOptions {
        let mut watch_config = vault_watch::WatchConfig {
            debounce: Duration::from_millis(self.watch_debounce_ms),
            ..vault_watch::WatchConfig::default()
        };
        // The hard ceiling keeps its documented relationship to the debounce
        // window, so tuning one never silently defeats the other.
        watch_config.max_debounce = watch_config.debounce * 10;
        RuntimeOptions {
            watch: !self.no_watch,
            watch_config,
            // Zero means "never", not "every instant".
            reconcile_interval: match self.reconcile_interval_seconds {
                0 => None,
                seconds => Some(Duration::from_secs(seconds)),
            },
            read_only: self.read_only,
            ..RuntimeOptions::default()
        }
    }
}

/// A server, the notice stream its transport must forward if it has one, and
/// the canonical vault root the server was configured with.
///
/// Health-only mode has no runtime, so there is nothing to forward — and no
/// vault, so there is no root. The root is carried out rather than recomputed
/// because the default socket path is a function of it: deriving a *second*
/// `IndexConfig` just to read it would import failure modes that have nothing
/// to do with sockets (the XDG cache lookup, and the refusal of a derived
/// index path that would land inside the vault), so a daemon given an
/// explicit `--index` safely outside its vault could be refused `--listen`
/// over an index path it was never going to use.
type ConfiguredServer = (Server, Option<Receiver<RuntimeNotice>>, Option<PathBuf>);

fn main() {
    // Before anything can parse a note: a contained parse panic must read as a
    // warning, not as a crash report for a daemon that is still serving.
    vault_server::install_panic_hook();
    if let Err(error) = run() {
        eprintln!("vaultd: {error}");
        std::process::exit(2);
    }
}

/// Health-only mode starts no runtime at all: no watcher, no lease, no
/// graph, no timer, and no threads beyond the transport's own.
fn configured_server(cli: &Cli) -> Result<ConfiguredServer, Box<dyn Error>> {
    let config = match (&cli.vault, &cli.index) {
        (None, None) => return Ok((Server::health_only(), None, None)),
        (Some(vault), None) => IndexConfig::derived(vault)?,
        (Some(vault), Some(index)) => IndexConfig::explicit(vault, index)?,
        (None, Some(_)) => unreachable!("clap enforces --index requires --vault"),
    };
    let canonical_vault_root = config.canonical_vault_root.clone();
    let (mut server, notices) = Server::start(config, cli.runtime_options())?;
    // In range by the parser (1 to 4096), so the conversion cannot fail.
    server.set_base_cache_entries(usize::try_from(cli.bases_cache_entries)?);
    // In range by the parser (1 to 1024), so the conversion cannot fail.
    server.set_search_cache_entries(usize::try_from(cli.search_cache_entries)?);
    Ok((server, Some(notices), Some(canonical_vault_root)))
}

fn run() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    // **Before the runtime is built and before anything is bound.** Cold
    // hydration of a large vault takes seconds, and a SIGTERM arriving in
    // them would otherwise take the default disposition: the process dies on
    // the signal, exit 143, no `stopped` notice — and if it lands in the
    // window just after the bind, it dies with the socket file already
    // created and no `Drop` to unlink it. The handlers only write a byte to a
    // pipe, so installing them this early costs nothing and no one reads the
    // flag until `service::run` spawns its watcher, which finds the byte
    // waiting for it.
    //
    // **Only when this daemon is going to listen.** Without `--listen` there
    // is no watcher and nobody would ever read the flag, so installing a
    // handler would swallow SIGTERM and leave a stdio-only daemon stoppable
    // by nothing but SIGKILL — a regression on the daemon that always
    // shipped.
    let watch = match cli.listen {
        Some(_) => Some(vault_server::signals::install()?),
        None => None,
    };
    let (server, notices, canonical_vault_root) = configured_server(&cli)?;
    let listen = match (&cli.listen, &canonical_vault_root) {
        (None, _) => None,
        (Some(Some(path)), _) => Some(path.clone()),
        // The root this daemon is actually serving, not a second derivation
        // of it. See `ConfiguredServer`.
        (Some(None), Some(root)) => Some(vault_server::listener::default_socket_path(root)?),
        // clap enforces `--listen` requires `--vault`, and a `--vault` is
        // exactly what gives `configured_server` a root to hand back.
        (Some(None), None) => unreachable!("--listen requires --vault"),
    };
    // Answered by `get_vault_info` so a client on stdio can tell others where
    // to knock. Set by `service::run` itself, once the bind that path names
    // has actually succeeded — not here, where `listen` is only the path this
    // daemon *intends* to bind.
    vault_server::service::run(
        server,
        notices,
        vault_server::service::ServiceOptions {
            // Stdin is a door like any other and is served while it is open.
            // A daemon started with stdin closed (systemd) simply reaches end
            // of file at once, which ends connection zero and nothing else.
            stdio: true,
            listen,
        },
        watch,
    )
    .map_err(Into::into)
}
