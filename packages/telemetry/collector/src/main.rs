//! `executor-collector`: the telemetry collector bundled with Executor.
//!
//! It receives OTLP/HTTP JSON traces and logs from the product and keeps them in one SQLite file.
//! See `README.md` in this directory.

use std::future::{Future, IntoFuture};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::sync::Semaphore;

use executor_collector::args::{self, Listen};
use executor_collector::lifecycle::{self, Stop};
use executor_collector::{http, log, store};

/// The whole shutdown, from the stop signal until the process exits. The local host kills the
/// collector 3 s after asking it to stop (the self-host supervisor waits 15 s); this leaves half a
/// second spare.
const STOP_BUDGET: Duration = Duration::from_millis(2_500);
/// Of that, how long open requests get to finish. The rest is for the writer: the export it is
/// storing (at most `store::BUSY_TIMEOUT` waiting for a lock, plus its own work), saving the
/// refusal counts and closing the store.
const DRAIN: Duration = Duration::from_millis(1_500);

fn main() -> ExitCode {
    // Before any thread starts: the allocator's arena count is fixed when threads first allocate.
    store::limit_memory_arenas();
    let args = match args::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            log::error(
                "cannot start the runtime",
                &[("error", error.to_string().into())],
            );
            return ExitCode::FAILURE;
        }
    };
    let losses = Arc::new(Mutex::new(store::LossBook::default()));
    let release = Arc::new(store::MemoryRelease::default());
    let writer = match store::start(
        &args.data,
        args.max_pending,
        losses.clone(),
        release.clone(),
    ) {
        Ok(writer) => writer,
        Err(error) => {
            log::error(
                "cannot open the telemetry store",
                &[
                    (
                        "path",
                        store::database_path(&args.data)
                            .display()
                            .to_string()
                            .into(),
                    ),
                    ("error", error.into()),
                ],
            );
            return ExitCode::FAILURE;
        }
    };
    let app = Arc::new(http::App {
        max_pending: args.max_pending,
        max_export_bytes: args.max_export_bytes,
        admission: Arc::new(Semaphore::new(args.max_pending)),
        jobs: writer.sender(),
        losses,
        last_refusal_log: Mutex::new(None),
        release,
    });
    let stopped_at = Arc::new(Mutex::new(None));
    let served = runtime.block_on(serve(args.listen.clone(), app, stopped_at.clone()));
    let deadline = stopped_at
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .map_or_else(
            || Instant::now() + STOP_BUDGET,
            |at: Instant| at + STOP_BUDGET,
        );
    // Requests still open are dropped here; a dropped sender sees no acknowledgement and resends.
    runtime.shutdown_timeout(Duration::from_millis(100));
    if !writer.close(deadline) {
        log::warn(
            "the store did not close within the shutdown budget; exiting without it",
            &[],
        );
    }
    match served {
        Ok(()) => {
            log::info("collector stopped", &[]);
            ExitCode::SUCCESS
        }
        Err(error) => {
            log::error("collector failed", &[("error", error.into())]);
            ExitCode::FAILURE
        }
    }
}

async fn serve(
    listen: Listen,
    app: Arc<http::App>,
    stopped_at: Arc<Mutex<Option<Instant>>>,
) -> Result<(), String> {
    let router = http::router(app);
    // Registered before the listening line, so a stop signal sent as soon as it appears is
    // handled, not left to the default action that ends the process at once.
    let signal = stop_signal()?;
    let stopping = Stop::default();
    let stop = {
        let stopping = stopping.clone();
        async move {
            signal.await;
            *stopped_at
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
            log::info("stopping", &[]);
            stopping.set();
        }
    };
    match listen {
        Listen::Tcp(address) => {
            let listener = tokio::net::TcpListener::bind(&address)
                .await
                .map_err(|error| format!("cannot listen on {address}: {error}"))?;
            let port = listener
                .local_addr()
                .map_err(|error| error.to_string())?
                .port();
            ready(json!({ "event": "listening", "port": port }));
            lifecycle::drain(
                axum::serve(listener, router)
                    .with_graceful_shutdown(stop)
                    .into_future(),
                &stopping,
                DRAIN,
            )
            .await
        }
        #[cfg(unix)]
        Listen::Unix(path) => {
            // Binding fails when anything exists at the path. The collector never removes a path
            // it did not create: whatever supervises it owns the directory and removes a socket
            // file an earlier run left behind, as the self-host Go host does before each start.
            let listener = tokio::net::UnixListener::bind(&path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AddrInUse {
                    format!(
                        "cannot listen on {}: the path already exists; the collector does not remove a path it did not create",
                        path.display()
                    )
                } else {
                    format!("cannot listen on {}: {error}", path.display())
                }
            })?;
            let bound = socket_identity(&path);
            ready(json!({ "event": "listening", "path": path.display().to_string() }));
            let result = lifecycle::drain(
                axum::serve(listener, router)
                    .with_graceful_shutdown(stop)
                    .into_future(),
                &stopping,
                DRAIN,
            )
            .await;
            // Only this process's socket: another collector may have taken the path since. The
            // check and the removal are two steps, which is safe while only the supervisor, one
            // collector at a time, changes the directory.
            if bound.is_some() && socket_identity(&path) == bound {
                let _ = std::fs::remove_file(&path);
            }
            result
        }
        #[cfg(not(unix))]
        Listen::Unix(_) => Err("Unix sockets are not supported on this platform".to_owned()),
    }
}

/// The readiness line: the one line the collector writes on stdout.
fn ready(line: serde_json::Value) {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

/// The file at `path`, by device and inode, to tell this process's socket from a later one.
#[cfg(unix)]
fn socket_identity(path: &std::path::Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path)
        .ok()
        .map(|metadata| (metadata.dev(), metadata.ino()))
}

/// Start listening for the stop signals now; the future resolves when one arrives.
#[cfg(unix)]
fn stop_signal() -> Result<impl Future<Output = ()>, String> {
    use tokio::signal::unix::{SignalKind, signal};
    let failed = |error: std::io::Error| format!("cannot listen for stop signals: {error}");
    let mut terminate = signal(SignalKind::terminate()).map_err(failed)?;
    let mut interrupt = signal(SignalKind::interrupt()).map_err(failed)?;
    Ok(async move {
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
    })
}

/// Start listening for the stop signals now; the future resolves when one arrives.
#[cfg(windows)]
fn stop_signal() -> Result<impl Future<Output = ()>, String> {
    use tokio::signal::windows::{ctrl_break, ctrl_c};
    let failed = |error: std::io::Error| format!("cannot listen for stop signals: {error}");
    let mut brk = ctrl_break().map_err(failed)?;
    let mut interrupt = ctrl_c().map_err(failed)?;
    Ok(async move {
        tokio::select! {
            _ = brk.recv() => {}
            _ = interrupt.recv() => {}
        }
    })
}
