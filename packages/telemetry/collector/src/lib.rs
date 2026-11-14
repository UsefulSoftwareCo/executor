//! The telemetry collector bundled with Executor: OTLP/HTTP JSON in, one SQLite file. The
//! `executor-collector` binary in `main.rs` runs it; see `README.md` in this directory.

pub mod args;
pub mod body;
pub mod connection;
pub mod http;
pub mod lifecycle;
pub mod log;
pub mod memory;
pub mod otlp;
pub mod query;
pub mod readers;
pub mod retention;
pub mod store;
pub mod text;
mod unicode61;
