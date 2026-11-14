//! The HTTP routes: OTLP/HTTP JSON ingest, health and ingest status.
//!
//! Admission bounds the memory exports can hold. An export takes one of `max-pending` permits
//! before its body is read and keeps it until it is stored, so at most `max-pending` bodies of at
//! most `max-export-bytes`, with their decoded rows, are in memory at once. Every export that is
//! not stored is counted by reason. OTLP exporters retry 429, 500 and 503 and drop 400, 413 and
//! 415, so a malformed or oversized export is answered as final and a storage failure as
//! transient.

use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, RawQuery, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};

use crate::connection::{self, ResponseDeadline};
use crate::log;
use crate::otlp;
use crate::query::{self, LogFilter, Query};
use crate::readers::Readers;
use crate::store::{self, Export, Job, Losses, MemoryRelease, Shared, SharedLosses};

const REFUSAL_LOG_INTERVAL: Duration = Duration::from_secs(60);

pub struct App {
    pub max_pending: usize,
    pub max_export_bytes: usize,
    pub admission: Arc<Semaphore>,
    pub jobs: SyncSender<Job>,
    pub losses: SharedLosses,
    pub last_refusal_log: Mutex<Option<Instant>>,
    pub release: Arc<MemoryRelease>,
    /// The writer's figures: the store's size for admission and `/api/ingest`.
    pub store: Arc<Shared>,
    pub readers: Arc<Readers>,
}

/// An admitted export: its permit, held until the export is stored or refused. Dropping it, on
/// any path, asks the writer to return the memory the export's body and rows used once idle.
struct Admitted {
    _permit: OwnedSemaphorePermit,
    release: Arc<MemoryRelease>,
}

impl Drop for Admitted {
    fn drop(&mut self) {
        self.release.request();
    }
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/v1/traces", post(traces))
        .route("/v1/logs", post(logs))
        .route("/api/health", get(health))
        .route("/api/ingest", get(ingest_status))
        .route("/api/services", get(services))
        .route("/api/traces", get(traces_list))
        .route("/api/traces/stats", get(trace_stats))
        .route("/api/traces/{trace_id}", get(trace))
        .route("/api/traces/{trace_id}/spans", get(trace_spans))
        .route("/api/traces/{trace_id}/logs", get(trace_logs))
        .route("/api/spans/search", get(search_spans))
        .route("/api/logs", get(logs_search))
        .route("/api/logs/search", get(logs_search))
        .fallback(not_found)
        .layer(axum::middleware::from_fn(connection::new_request))
        .with_state(app)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Signal {
    Traces,
    Logs,
}

#[derive(Clone, Copy)]
enum Loss {
    QueueFull,
    TooLarge,
    Invalid,
    StoreFailed,
    OverBound,
    TooMuchDisk,
}

/// An export is refused while the store's pages in use are more than this share of the bound.
/// Eviction normally keeps them within one export of it, so this means eviction cannot keep up,
/// for example because its steps fail.
const OVER_BOUND_PERCENT: u64 = 110;

async fn health() -> Response {
    axum::Json(json!({ "ok": true, "service": "executor-collector", "version": env!("CARGO_PKG_VERSION") })).into_response()
}

async fn services(
    State(app): State<Arc<App>>,
    ConnectInfo(deadline): ConnectInfo<ResponseDeadline>,
) -> Response {
    app.readers.answer(&deadline, query::services).await
}

async fn traces_list(
    State(app): State<Arc<App>>,
    ConnectInfo(deadline): ConnectInfo<ResponseDeadline>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = Query::parse(raw.as_deref());
    if !query.is_valid(query::TRACES_PARAMETERS) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    app.readers
        .answer(&deadline, move |connection, out| {
            query::traces(connection, out, &query)
        })
        .await
}

async fn trace_stats(
    State(app): State<Arc<App>>,
    ConnectInfo(deadline): ConnectInfo<ResponseDeadline>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = Query::parse(raw.as_deref());
    if !query.is_valid(query::STATS_PARAMETERS) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    app.readers
        .answer(&deadline, move |connection, out| {
            query::trace_stats(connection, out, &query)
        })
        .await
}

async fn trace(
    State(app): State<Arc<App>>,
    ConnectInfo(deadline): ConnectInfo<ResponseDeadline>,
    Path(trace_id): Path<String>,
) -> Response {
    app.readers
        .answer(&deadline, move |connection, out| {
            query::trace(connection, out, &trace_id)
        })
        .await
}

async fn trace_spans(
    State(app): State<Arc<App>>,
    ConnectInfo(deadline): ConnectInfo<ResponseDeadline>,
    Path(trace_id): Path<String>,
) -> Response {
    app.readers
        .answer(&deadline, move |connection, out| {
            query::trace_spans(connection, out, &trace_id)
        })
        .await
}

async fn trace_logs(
    State(app): State<Arc<App>>,
    ConnectInfo(deadline): ConnectInfo<ResponseDeadline>,
    Path(trace_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = Query::parse(raw.as_deref());
    if !query.is_valid(query::TRACE_LOGS_PARAMETERS) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    app.readers
        .answer(&deadline, move |connection, out| {
            query::logs(
                connection,
                out,
                LogFilter {
                    query: &query,
                    trace: Some(&trace_id),
                },
            )
        })
        .await
}

async fn search_spans(
    State(app): State<Arc<App>>,
    ConnectInfo(deadline): ConnectInfo<ResponseDeadline>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = Query::parse(raw.as_deref());
    if !query.is_valid(query::SPAN_SEARCH_PARAMETERS) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    app.readers
        .answer(&deadline, move |connection, out| {
            query::search_spans(connection, out, &query)
        })
        .await
}

async fn logs_search(
    State(app): State<Arc<App>>,
    ConnectInfo(deadline): ConnectInfo<ResponseDeadline>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = Query::parse(raw.as_deref());
    if !query.is_valid(query::LOGS_PARAMETERS) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    app.readers
        .answer(&deadline, move |connection, out| {
            query::logs(
                connection,
                out,
                LogFilter {
                    query: &query,
                    trace: None,
                },
            )
        })
        .await
}

async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({ "error": "Not found" })),
    )
        .into_response()
}

async fn ingest_status(State(app): State<Arc<App>>) -> Response {
    let losses = store::lock(&app.losses).counts().clone();
    axum::Json(status_json(&app, &losses)).into_response()
}

fn status_json(app: &App, losses: &Losses) -> Value {
    let figures = app.store.figures();
    json!({
        "pending": app.max_pending - app.admission.available_permits(),
        "maxPending": app.max_pending,
        "maxBytes": app.max_export_bytes,
        "refused": {
            "queueFull": losses.refused.queue_full,
            "tooLarge": losses.refused.too_large,
            "invalid": losses.refused.invalid,
            "storeFailed": losses.refused.store_failed,
            "overBound": losses.refused.over_bound,
            "tooMuchDisk": losses.refused.too_much_disk,
        },
        "refusedBytes": losses.refused_bytes,
        "lastRefusedAt": losses.last_refused_at,
        "droppedEvents": losses.dropped_events,
        "evictions": {
            "passes": figures.eviction_passes,
            "traces": figures.evicted_traces,
            "spans": figures.evicted_spans,
            "logs": figures.evicted_logs,
        },
        "store": {
            "usedBytes": figures.used_bytes,
            "fileBytes": figures.file_bytes,
            "walBytes": figures.wal_bytes,
            "maxBytes": figures.max_bytes,
            "retentionHours": figures.retention_hours,
            "draining": figures.draining,
            "maintenancePending": figures.pending_at(app.store.wall_ms()),
            "steps": figures.steps,
            "longestStepMs": figures.longest_step_micros as f64 / 1000.0,
            "longestExportWaitMs": figures.longest_export_wait_micros as f64 / 1000.0,
            "walFull": figures.wal_full,
            "checkpointsBlocked": figures.checkpoints_blocked,
            "walEmptied": figures.wal_emptied,
            "walRefuseBytes": figures.wal_refuse_bytes,
            "gateClosed": figures.gate_closed,
            "gateClosings": figures.gate_closings,
        },
        "readers": app.readers.figures(),
    })
}

async fn traces(State(app): State<Arc<App>>, request: Request) -> Response {
    ingest(app, Signal::Traces, request).await
}

async fn logs(State(app): State<Arc<App>>, request: Request) -> Response {
    ingest(app, Signal::Logs, request).await
}

async fn ingest(app: Arc<App>, signal: Signal, request: Request) -> Response {
    let headers = request.headers();
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok()?.trim().parse::<u64>().ok());
    let bytes = declared.unwrap_or(0);
    if declared.is_some_and(|length| length > app.max_export_bytes as u64) {
        return refuse(
            &app,
            Loss::TooLarge,
            bytes,
            StatusCode::PAYLOAD_TOO_LARGE,
            "Telemetry export exceeds the collector's size limit",
            None,
        );
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("application/x-protobuf")
        || content_type.contains("application/protobuf")
    {
        return refuse(
            &app,
            Loss::Invalid,
            bytes,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "The collector accepts OTLP/HTTP JSON only",
            None,
        );
    }
    // OTLP/HTTP servers must accept gzip as well as uncompressed bodies.
    let gzip = match headers
        .get(header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "identity" => false,
        "gzip" | "x-gzip" => true,
        _ => {
            return refuse(
                &app,
                Loss::Invalid,
                bytes,
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "The collector accepts uncompressed or gzip exports only",
                None,
            );
        }
    };
    let figures = app.store.figures();
    // Data past the bound means eviction is behind; a full write-ahead log means a reader keeps
    // a checkpoint from emptying it. Both are refused until they clear.
    if figures.wal_full {
        return refuse(
            &app,
            Loss::OverBound,
            bytes,
            StatusCode::TOO_MANY_REQUESTS,
            "The telemetry store's write-ahead log is full: a reader keeps it from being emptied",
            None,
        );
    }
    if figures.settled_used_bytes > figures.max_bytes / 100 * OVER_BOUND_PERCENT {
        return refuse(
            &app,
            Loss::OverBound,
            bytes,
            StatusCode::TOO_MANY_REQUESTS,
            "The telemetry store is over its size bound: eviction is behind",
            None,
        );
    }
    // Taken before the body is read and held until the export is stored or refused.
    let Ok(permit) = app.admission.clone().try_acquire_owned() else {
        return refuse(
            &app,
            Loss::QueueFull,
            declared.unwrap_or(0),
            StatusCode::TOO_MANY_REQUESTS,
            "Collector ingest queue is full",
            None,
        );
    };
    let admitted = Admitted {
        _permit: permit,
        release: app.release.clone(),
    };
    // Refused bytes are the declared length when there is one, as Motel counted them, otherwise
    // the bytes read before refusing.
    let mut body = request.into_body();
    let mut read: Vec<u8> = Vec::with_capacity(declared.unwrap_or(0) as usize);
    while let Some(frame) = body.frame().await {
        let data = match frame {
            Ok(frame) => match frame.into_data() {
                Ok(data) => data,
                Err(_) => continue,
            },
            Err(error) => {
                let message =
                    otlp::bounded(format_args!("The export's body could not be read: {error}"));
                let bytes = declared.unwrap_or(read.len() as u64);
                return refuse(
                    &app,
                    Loss::Invalid,
                    bytes,
                    StatusCode::BAD_REQUEST,
                    &message,
                    None,
                );
            }
        };
        if read.len() + data.len() > app.max_export_bytes {
            let bytes = declared.unwrap_or((read.len() + data.len()) as u64);
            return refuse(
                &app,
                Loss::TooLarge,
                bytes,
                StatusCode::PAYLOAD_TOO_LARGE,
                "Telemetry export exceeds the collector's size limit",
                None,
            );
        }
        read.extend_from_slice(&data);
    }
    let bytes = declared.unwrap_or(read.len() as u64);
    let body = Bytes::from(read);
    // Decoding and storing continue in their own task, holding the permit, even if the sender
    // hangs up: a started decode cannot be stopped, and an export already queued will be stored.
    // So the permits always count the exports the collector is working on.
    let worker = tokio::spawn(store(app.clone(), signal, body, gzip, bytes, admitted));
    match worker.await {
        Ok(response) => response,
        Err(error) => refuse(
            &app,
            Loss::StoreFailed,
            bytes,
            StatusCode::INTERNAL_SERVER_ERROR,
            "The export could not be stored",
            Some(error.to_string()),
        ),
    }
}

/// Decode an admitted export, queue it for the writer and wait until it is stored.
async fn store(
    app: Arc<App>,
    signal: Signal,
    body: Bytes,
    gzip: bool,
    bytes: u64,
    admitted: Admitted,
) -> Response {
    let (reply, answer) = oneshot::channel();
    let limit = app.max_export_bytes;
    let store = app.store.clone();
    let decoded = tokio::task::spawn_blocking(move || {
        let text: std::borrow::Cow<[u8]> = if gzip {
            std::borrow::Cow::Owned(gunzip(&body, limit)?)
        } else {
            std::borrow::Cow::Borrowed(&body)
        };
        match signal {
            Signal::Traces => otlp::decode_spans_within(&text, limit).map(Export::Spans),
            Signal::Logs => otlp::decode_logs_within(&text, limit).map(Export::Logs),
        }
        .map(|export| {
            let dropped_events = match &export {
                Export::Spans(spans) => spans.events_dropped,
                Export::Logs(_) => 0,
            };
            let job = Job {
                export,
                reply,
                maintenance_at_queue: store
                    .maintenance_micros
                    .load(std::sync::atomic::Ordering::SeqCst),
            };
            (job, dropped_events)
        })
        .map_err(|undecodable| match undecodable {
            otlp::Undecodable::Invalid(invalid) => Unreadable::Invalid(invalid.0),
            otlp::Undecodable::TooLarge => Unreadable::Decoded,
        })
    })
    .await;
    let (job, dropped_events) = match decoded {
        Ok(Ok(decoded)) => decoded,
        Ok(Err(Unreadable::Invalid(message))) => {
            return refuse(
                &app,
                Loss::Invalid,
                bytes,
                StatusCode::BAD_REQUEST,
                &message,
                None,
            );
        }
        Ok(Err(Unreadable::TooLarge)) => {
            return refuse(
                &app,
                Loss::TooLarge,
                bytes,
                StatusCode::PAYLOAD_TOO_LARGE,
                "Telemetry export exceeds the collector's size limit once decompressed",
                None,
            );
        }
        Ok(Err(Unreadable::Decoded)) => {
            return refuse(
                &app,
                Loss::TooLarge,
                bytes,
                StatusCode::PAYLOAD_TOO_LARGE,
                "Telemetry export takes more memory to decode than the collector allows",
                None,
            );
        }
        Err(panic) => {
            return refuse(
                &app,
                Loss::Invalid,
                bytes,
                StatusCode::BAD_REQUEST,
                "The export could not be decoded",
                Some(panic.to_string()),
            );
        }
    };
    match app.jobs.try_send(job) {
        Ok(()) => {}
        // Each queued export holds a permit and the queue holds as many exports as there are
        // permits, so it cannot be full.
        Err(TrySendError::Full(_)) => {
            return refuse(
                &app,
                Loss::QueueFull,
                bytes,
                StatusCode::TOO_MANY_REQUESTS,
                "Collector ingest queue is full",
                None,
            );
        }
        Err(TrySendError::Disconnected(_)) => return unavailable(&app, bytes),
    }
    let response = match answer.await {
        Ok(Ok(count)) => {
            if dropped_events > 0 {
                store::lock(&app.losses).record(|losses| losses.dropped_events += dropped_events);
            }
            let key = if signal == Signal::Traces {
                "insertedSpans"
            } else {
                "insertedLogs"
            };
            axum::Json(json!({ key: count })).into_response()
        }
        Ok(Err(store::Unstored::TooMuchDisk(detail))) => refuse(
            &app,
            Loss::TooMuchDisk,
            bytes,
            StatusCode::PAYLOAD_TOO_LARGE,
            "Telemetry export takes more disk to store than the collector allows",
            Some(detail),
        ),
        Ok(Err(store::Unstored::Failed(error))) => {
            let message = format!(
                "The {} export could not be stored",
                if signal == Signal::Traces {
                    "traces"
                } else {
                    "logs"
                }
            );
            refuse(
                &app,
                Loss::StoreFailed,
                bytes,
                StatusCode::INTERNAL_SERVER_ERROR,
                &message,
                Some(error),
            )
        }
        Err(_) => unavailable(&app, bytes),
    };
    drop(admitted);
    response
}

/// Why an admitted body could not be decoded.
enum Unreadable {
    Invalid(String),
    TooLarge,
    /// It would take more than its budget to decode (`otlp::DECODE_SHARE`), or a row of it more text
    /// than a row may hold (`otlp::ROW_SHARE`).
    Decoded,
}

/// Decompress a gzip body, refusing it once it passes `limit` bytes: the size limit holds after
/// decompression, as OTLP requires, so a small body cannot expand without bound.
fn gunzip(body: &[u8], limit: usize) -> Result<Vec<u8>, Unreadable> {
    use std::io::Read;
    let mut text = Vec::new();
    let read = flate2::read::MultiGzDecoder::new(body)
        .take(limit as u64 + 1)
        .read_to_end(&mut text)
        .map_err(|error| {
            Unreadable::Invalid(otlp::bounded(format_args!(
                "The export's gzip body could not be read: {error}"
            )))
        })?;
    if read > limit {
        return Err(Unreadable::TooLarge);
    }
    Ok(text)
}

/// The writer has stopped, which happens only while the collector shuts down.
fn unavailable(app: &App, bytes: u64) -> Response {
    let mut response = refuse(
        app,
        Loss::StoreFailed,
        bytes,
        StatusCode::SERVICE_UNAVAILABLE,
        "Telemetry store is unavailable",
        None,
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("10"));
    response
}

/// Count an export that was not stored and answer it. A storage failure is logged every time with
/// its cause; refusals under load at most once a minute, with the counts so far.
fn refuse(
    app: &App,
    loss: Loss,
    bytes: u64,
    status: StatusCode,
    message: &str,
    cause: Option<String>,
) -> Response {
    // Every message is bounded where it is made (`otlp::Excerpt`); a cause from the store or a
    // task is not ours, so it is cut to `otlp::MESSAGE_BYTES` for the log line.
    let cause = cause.map(otlp::bounded);
    let counts = {
        let mut book = store::lock(&app.losses);
        book.record(|losses| {
            let refused = &mut losses.refused;
            *match loss {
                Loss::QueueFull => &mut refused.queue_full,
                Loss::TooLarge => &mut refused.too_large,
                Loss::Invalid => &mut refused.invalid,
                Loss::StoreFailed => &mut refused.store_failed,
                Loss::OverBound => &mut refused.over_bound,
                Loss::TooMuchDisk => &mut refused.too_much_disk,
            } += 1;
            losses.refused_bytes += bytes;
            losses.last_refused_at = Some(iso_now());
        });
        book.counts().clone()
    };
    let due = {
        let mut last = app
            .last_refusal_log
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let due = matches!(loss, Loss::StoreFailed)
            || last.is_none_or(|at| at.elapsed() >= REFUSAL_LOG_INTERVAL);
        if due {
            *last = Some(Instant::now());
        }
        due
    };
    if due {
        let reason = match loss {
            Loss::QueueFull => "queueFull",
            Loss::TooLarge => "tooLarge",
            Loss::Invalid => "invalid",
            Loss::StoreFailed => "storeFailed",
            Loss::OverBound => "overBound",
            Loss::TooMuchDisk => "tooMuchDisk",
        };
        let mut fields = vec![
            ("reason", Value::from(reason)),
            ("detail", Value::from(message)),
            ("ingest", status_json(app, &counts)),
        ];
        if let Some(cause) = cause {
            fields.push(("cause", cause.into()));
        }
        log::warn("telemetry exports not stored", &fields);
    }
    let mut response = (status, axum::Json(json!({ "error": message }))).into_response();
    if matches!(loss, Loss::QueueFull | Loss::OverBound) {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    }
    response
}

/// The current time as an ISO 8601 string in UTC with milliseconds, as JavaScript's
/// `Date.prototype.toISOString` writes it.
fn iso_now() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = elapsed.as_secs() as i64;
    let (days, of_day) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Howard Hinnant's days-to-civil conversion.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60,
        elapsed.subsec_millis()
    )
}
