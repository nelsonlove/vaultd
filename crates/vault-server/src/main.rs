use std::error::Error;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use clap::Parser;
use serde::Deserialize;
use vault_index::IndexConfig;
use vault_protocol::{
    ErrorCode, ProtocolError, Request, RequestEnvelope, ResponseEnvelope, validate_version,
};
use vault_server::Server;

#[derive(Debug, Parser)]
#[command(name = "vaultd", version, about)]
struct Cli {
    #[arg(long, value_name = "PATH")]
    vault: Option<PathBuf>,
    #[arg(long, value_name = "PATH", requires = "vault")]
    index: Option<PathBuf>,
}

/// First parse stage: the envelope with the request left undecoded, so the
/// version can be validated before the version-specific method enum is applied.
#[derive(Deserialize)]
struct RawRequestEnvelope {
    version: u16,
    id: String,
    request: serde_json::Value,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("vaultd: {error}");
        std::process::exit(2);
    }
}

fn configured_server(cli: &Cli) -> Result<Server, Box<dyn Error>> {
    match (&cli.vault, &cli.index) {
        (None, None) => Ok(Server::health_only()),
        (Some(vault), None) => Server::open(IndexConfig::derived(vault)?).map_err(Into::into),
        (Some(vault), Some(index)) => {
            Server::open(IndexConfig::explicit(vault, index)?).map_err(Into::into)
        }
        (None, Some(_)) => unreachable!("clap enforces --index requires --vault"),
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    let mut server = configured_server(&cli)?;
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let raw: RawRequestEnvelope = serde_json::from_str(&line)?;
        let response = respond(&mut server, raw);
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

fn respond(server: &mut Server, raw: RawRequestEnvelope) -> ResponseEnvelope {
    if let Err(error) = validate_version(raw.version) {
        return ResponseEnvelope::error(raw.id, error);
    }
    match serde_json::from_value::<Request>(raw.request) {
        Ok(request) => server.handle(RequestEnvelope {
            version: raw.version,
            id: raw.id,
            request,
        }),
        Err(error) => ResponseEnvelope::error(
            raw.id,
            ProtocolError {
                code: ErrorCode::InvalidRequest,
                message: format!("invalid request: {error}"),
                supported_version: None,
                current_generation: None,
            },
        ),
    }
}
