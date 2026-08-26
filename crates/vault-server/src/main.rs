use std::error::Error;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use clap::Parser;
use vault_index::IndexConfig;
use vault_server::Server;
use vault_server::runtime::{RuntimeNotice, RuntimeOptions};
use vault_server::stdio;

#[derive(Debug, Parser)]
#[command(name = "vaultd", version, about)]
struct Cli {
    #[arg(long, value_name = "PATH")]
    vault: Option<PathBuf>,
    #[arg(long, value_name = "PATH", requires = "vault")]
    index: Option<PathBuf>,
    // The three tuning flags describe a runtime, and health-only mode has
    // none, so each requires `--vault` exactly as `--index` does. Accepting
    // them without one would silently do nothing. `requires` is evaluated
    // only for values that came from the command line, so the defaults below
    // still leave bare `vaultd` valid.
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
            ..RuntimeOptions::default()
        }
    }
}

/// A server and the notice stream its transport must forward, if it has one.
/// Health-only mode has no runtime, so there is nothing to forward.
type ConfiguredServer = (Server, Option<Receiver<RuntimeNotice>>);

fn main() {
    if let Err(error) = run() {
        eprintln!("vaultd: {error}");
        std::process::exit(2);
    }
}

/// Health-only mode starts no runtime at all: no watcher, no lease, no
/// graph, no timer, and no threads beyond the transport's own.
fn configured_server(cli: &Cli) -> Result<ConfiguredServer, Box<dyn Error>> {
    let config = match (&cli.vault, &cli.index) {
        (None, None) => return Ok((Server::health_only(), None)),
        (Some(vault), None) => IndexConfig::derived(vault)?,
        (Some(vault), Some(index)) => IndexConfig::explicit(vault, index)?,
        (None, Some(_)) => unreachable!("clap enforces --index requires --vault"),
    };
    let (server, notices) = Server::start(config, cli.runtime_options())?;
    Ok((server, Some(notices)))
}

fn run() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    let (server, notices) = configured_server(&cli)?;
    stdio::run(server, notices).map_err(Into::into)
}
