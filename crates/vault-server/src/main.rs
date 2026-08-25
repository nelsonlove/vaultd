use std::error::Error;
use std::io::{self, BufRead, Write};

use vault_protocol::RequestEnvelope;
use vault_server::Server;

fn main() {
    if let Err(error) = run() {
        eprintln!("vaultd: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let server = Server;
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: RequestEnvelope = serde_json::from_str(&line)?;
        let response = server.handle(request);
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}
