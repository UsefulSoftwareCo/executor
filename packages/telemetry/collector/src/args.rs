//! Command-line flags. One set of defaults serves every host.

use std::path::PathBuf;

pub const USAGE: &str = "usage: executor-collector serve --data <dir> [--listen <127.0.0.1:port | unix:path>]
    [--max-pending <n>] [--max-export-bytes <n>]

  --data              directory holding telemetry.sqlite (created if missing)
  --listen            address to listen on (default 127.0.0.1:0); port 0 picks a free port
  --max-pending       exports read, decoded or stored at once; more are refused with 429 (default 4)
  --max-export-bytes  largest export body accepted; larger ones are refused with 413 (default 16777216)

Once listening, prints one line on stdout: {\"event\":\"listening\",\"port\":N} for TCP or
{\"event\":\"listening\",\"path\":P} for a Unix socket.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Listen {
    Tcp(String),
    Unix(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Args {
    pub data: PathBuf,
    pub listen: Listen,
    pub max_pending: usize,
    pub max_export_bytes: usize,
}

pub fn parse(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    match args.next().as_deref() {
        Some("serve") => {}
        Some("--help" | "-h") | None => return Err(USAGE.to_owned()),
        Some(other) => return Err(format!("unknown command {other:?}\n\n{USAGE}")),
    }
    let mut data = None;
    let mut listen = Listen::Tcp("127.0.0.1:0".to_owned());
    let mut max_pending = 4;
    let mut max_export_bytes = 16 * 1024 * 1024;
    while let Some(flag) = args.next() {
        let (name, inline) = match flag.split_once('=') {
            Some((name, value)) => (name.to_owned(), Some(value.to_owned())),
            None => (flag, None),
        };
        if name == "--help" || name == "-h" {
            return Err(USAGE.to_owned());
        }
        let value = match inline {
            Some(value) => value,
            None => args.next().ok_or_else(|| format!("{name} needs a value"))?,
        };
        match name.as_str() {
            "--data" => data = Some(PathBuf::from(value)),
            "--listen" => {
                listen = match value.strip_prefix("unix:") {
                    Some(path) if !path.is_empty() => Listen::Unix(PathBuf::from(path)),
                    Some(_) => return Err("--listen unix: needs a path".to_owned()),
                    None => Listen::Tcp(value),
                }
            }
            "--max-pending" => max_pending = positive(&name, &value)?,
            "--max-export-bytes" => max_export_bytes = positive(&name, &value)?,
            _ => return Err(format!("unknown flag {name}\n\n{USAGE}")),
        }
    }
    Ok(Args {
        data: data.ok_or_else(|| format!("--data is required\n\n{USAGE}"))?,
        listen,
        max_pending,
        max_export_bytes,
    })
}

fn positive(name: &str, value: &str) -> Result<usize, String> {
    match value.parse::<usize>() {
        Ok(number) if number > 0 => Ok(number),
        _ => Err(format!(
            "{name} must be a positive whole number, got {value:?}"
        )),
    }
}
