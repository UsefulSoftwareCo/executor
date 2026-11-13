//! The SQLite store and the one thread that writes it.
//!
//! The writer thread owns the only read-write connection. Each export is one transaction, and its
//! sender is answered only after that transaction commits, so an acknowledged export survives the
//! process being killed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::log;
use crate::otlp::{Logs, ResourceRow, SpanRow, Spans};

/// The store's format, kept in `PRAGMA user_version`. Raise it with every change to `SCHEMA`.
pub const FORMAT: i64 = 1;

/// The store's tables. Notes on choices that are expensive to change later:
///
/// - `spans` is an ordinary rowid table with a unique index on `(trace, span_id)`. Measured on
///   133,029 spans from a real local install, its rows average about 1 KB, and a `WITHOUT ROWID`
///   table took 2,910 bytes a span against 1,248: SQLite's guidance is that `WITHOUT ROWID` suits
///   rows under about a twentieth of a page. Rowids also give a stable insertion order.
/// - A resource has no age. Spans and logs refer to it, `spans_resource` and `logs_resource` find
///   those references, and whatever deletes the last of them deletes the resource in the same
///   transaction.
/// - A trace's `last_seen_ms` is when a span of it was last written. An unchanged resend writes
///   nothing, so it does not make the trace younger.
/// - Logs are kept in insertion order by their rowid, so the oldest are found without an index on
///   `seen_ms`.
/// - Traces keep their summary up to date as spans arrive, without reading the trace's other
///   spans; `root_started_ns` is what that needs to choose the earliest root.
const SCHEMA: &str = "
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE resources (
  id INTEGER PRIMARY KEY,
  attributes_json TEXT NOT NULL UNIQUE,
  service_name TEXT NOT NULL
);

CREATE TABLE traces (
  id INTEGER PRIMARY KEY,
  trace_id BLOB NOT NULL UNIQUE,
  service_name TEXT NOT NULL,
  root_name TEXT,
  root_started_ns INTEGER,
  started_ns INTEGER NOT NULL,
  ended_ns INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  span_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  running_count INTEGER NOT NULL
);
CREATE INDEX traces_started ON traces (started_ns);
CREATE INDEX traces_service_started ON traces (service_name, started_ns);
CREATE INDEX traces_last_seen ON traces (last_seen_ms);

CREATE TABLE spans (
  id INTEGER PRIMARY KEY,
  trace INTEGER NOT NULL,
  span_id BLOB NOT NULL,
  parent_span_id BLOB,
  resource INTEGER NOT NULL,
  scope_name TEXT,
  name TEXT NOT NULL,
  kind INTEGER,
  start_ns INTEGER NOT NULL,
  end_ns INTEGER NOT NULL,
  status INTEGER NOT NULL,
  attributes_json TEXT NOT NULL,
  events_json TEXT
);
CREATE UNIQUE INDEX spans_trace_span ON spans (trace, span_id);
CREATE INDEX spans_start ON spans (start_ns);
CREATE INDEX spans_resource ON spans (resource);

CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  trace_id BLOB,
  span_id BLOB,
  resource INTEGER NOT NULL,
  scope_name TEXT,
  severity_text TEXT NOT NULL,
  time_ns INTEGER NOT NULL,
  seen_ms INTEGER NOT NULL,
  body TEXT NOT NULL,
  attributes_json TEXT NOT NULL
);
CREATE INDEX logs_time ON logs (time_ns);
CREATE INDEX logs_trace ON logs (trace_id, time_ns) WHERE trace_id IS NOT NULL;
CREATE INDEX logs_resource ON logs (resource);
";

/// Set before the first table exists; SQLite cannot change it afterwards without a `VACUUM` that
/// rewrites the whole file. Incremental mode lets a later `PRAGMA incremental_vacuum` give free
/// pages back to the file system, which is the only way the file can shrink after deletes. In the
/// default mode freed pages are only reused.
const AUTO_VACUUM_INCREMENTAL: i64 = 2;

/// Why exports were not stored, kept in `meta` so the counts survive a restart.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Losses {
    pub refused: Refused,
    pub refused_bytes: u64,
    pub last_refused_at: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Refused {
    pub queue_full: u64,
    pub too_large: u64,
    pub invalid: u64,
    pub store_failed: u64,
    pub over_bound: u64,
}

/// Loss counts shared between the HTTP handlers, which count, and the writer, which saves them.
#[derive(Default)]
pub struct LossBook {
    counts: Losses,
    unsaved: bool,
}

pub type SharedLosses = Arc<Mutex<LossBook>>;

impl LossBook {
    pub fn counts(&self) -> &Losses {
        &self.counts
    }

    pub fn record(&mut self, update: impl FnOnce(&mut Losses)) {
        update(&mut self.counts);
        self.unsaved = true;
    }
}

/// Lock the loss book. A panic while it was held cannot leave counts half-written, so a
/// poisoned lock is still usable.
pub fn lock(losses: &SharedLosses) -> std::sync::MutexGuard<'_, LossBook> {
    losses
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub enum Job {
    Spans(Spans, oneshot::Sender<Result<usize, String>>),
    Logs(Logs, oneshot::Sender<Result<usize, String>>),
}

/// The handle the HTTP side uses to reach the writer thread.
pub struct Writer {
    jobs: SyncSender<Job>,
    stopping: Arc<AtomicBool>,
    finished: mpsc::Receiver<()>,
    thread: JoinHandle<()>,
}

/// A request to return freed memory to the system once the collector is idle. Whatever finishes
/// work that allocated for an export, stored or refused, asks for it; the writer acts on it.
#[derive(Default)]
pub struct MemoryRelease {
    at: Mutex<Option<Instant>>,
}

impl MemoryRelease {
    /// Release memory `RELEASE_MEMORY_AFTER` from now, or later if already asked for later.
    pub fn request(&self) {
        let at = Instant::now() + RELEASE_MEMORY_AFTER;
        let mut due = self
            .at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if due.is_none_or(|due| due < at) {
            *due = Some(at);
        }
    }

    fn due(&self) -> Option<Instant> {
        *self
            .at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn take_if_due(&self) -> bool {
        let mut due = self
            .at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if due.is_some_and(|at| at <= Instant::now()) {
            *due = None;
            return true;
        }
        false
    }
}

impl Writer {
    /// The export queue. The admission limit already bounds how many exports can be queued, so
    /// the channel never fills; a send fails only after the writer has stopped.
    pub fn sender(&self) -> SyncSender<Job> {
        self.jobs.clone()
    }

    /// Stop the writer by `deadline`. The export it is storing, if any, finishes; exports still
    /// queued are abandoned unanswered, so their senders never see them acknowledged and resend
    /// them. Then it saves the refusal counts and closes the store. Returns false when the writer
    /// had not finished by the deadline: the process then exits anyway, and SQLite discards a
    /// transaction it had not committed.
    pub fn close(self, deadline: Instant) -> bool {
        self.stopping.store(true, Ordering::SeqCst);
        drop(self.jobs);
        let finished = self
            .finished
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_ok();
        if finished {
            let _ = self.thread.join();
        }
        finished
    }
}

pub fn database_path(data: &Path) -> PathBuf {
    data.join("telemetry.sqlite")
}

/// Open or create the store and start its writer. Fails, without changing the file, when the
/// store cannot be opened, has another format or does not hold this format's schema.
pub fn start(
    data: &Path,
    queue: usize,
    losses: SharedLosses,
    release: Arc<MemoryRelease>,
) -> Result<Writer, String> {
    std::fs::create_dir_all(data)
        .map_err(|error| format!("cannot create {}: {error}", data.display()))?;
    let connection = open(&database_path(data))?;
    if let Some(saved) = connection
        .query_row("SELECT value FROM meta WHERE key = 'losses'", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|error| error.to_string())?
    {
        let saved: Losses = serde_json::from_str(&saved).unwrap_or_default();
        lock(&losses).counts = saved;
    }
    let (jobs, inbox) = mpsc::sync_channel::<Job>(queue);
    let (done, finished) = mpsc::channel();
    let stopping = Arc::new(AtomicBool::new(false));
    let writer = Writer {
        jobs,
        stopping: stopping.clone(),
        finished,
        thread: std::thread::Builder::new()
            .name("store-writer".to_owned())
            .spawn(move || {
                run(connection, inbox, losses, &release, &stopping);
                let _ = done.send(());
            })
            .map_err(|error| format!("cannot start the writer: {error}"))?,
    };
    Ok(writer)
}

/// Open the store, creating it when the file is new.
///
/// A file is new when it has no format and no tables: creating the tables and setting the format
/// is one transaction, so a start interrupted before that commit leaves a new file, and the next
/// start creates it again. A store of an older or newer format is refused and left as it is:
/// replacing or migrating an older store is not decided yet.
pub fn open(path: &Path) -> Result<Connection, String> {
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    let sqlite = |error: rusqlite::Error| error.to_string();
    // The collector is the store's only writer, so a lock is held only by another process, such
    // as someone inspecting the file. No single wait may outlast the shutdown budget.
    connection.busy_timeout(BUSY_TIMEOUT).map_err(sqlite)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sqlite)?;
    let objects: i64 = connection
        .query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))
        .map_err(sqlite)?;
    match version {
        0 if objects == 0 => {
            connection
                .pragma_update(None, "auto_vacuum", AUTO_VACUUM_INCREMENTAL)
                .map_err(sqlite)?;
            connection
                .pragma_update(None, "journal_mode", "WAL")
                .map_err(sqlite)?;
            let transaction = connection.transaction().map_err(sqlite)?;
            transaction.execute_batch(SCHEMA).map_err(sqlite)?;
            transaction
                .pragma_update(None, "user_version", FORMAT)
                .map_err(sqlite)?;
            transaction.commit().map_err(sqlite)?;
        }
        0 => return Err("the file holds tables but is not a telemetry store".to_owned()),
        FORMAT => {}
        older if older < FORMAT => {
            return Err(format!(
                "the store has format {older}, older than this collector's format {FORMAT}; remove the file to start a new store"
            ));
        }
        newer => {
            return Err(format!(
                "the store has format {newer}, newer than this collector's format {FORMAT}; it was written by a newer collector"
            ));
        }
    }
    validate(&connection)?;
    connection
        .execute_batch("PRAGMA synchronous = NORMAL; PRAGMA journal_size_limit = 67108864; PRAGMA cache_size = -8192;")
        .map_err(sqlite)?;
    Ok(connection)
}

/// One row of `sqlite_schema`: type, name, table and SQL.
type SchemaEntry = (String, String, String, Option<String>);

/// Check that the file holds exactly this format's schema, in WAL mode with incremental
/// auto-vacuum, by comparing it with the schema created in memory.
fn validate(connection: &Connection) -> Result<(), String> {
    let sqlite = |error: rusqlite::Error| error.to_string();
    let schema = |connection: &Connection| -> rusqlite::Result<Vec<SchemaEntry>> {
        connection
            .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")?
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect()
    };
    let expected = Connection::open_in_memory().map_err(sqlite)?;
    expected.execute_batch(SCHEMA).map_err(sqlite)?;
    if schema(connection).map_err(sqlite)? != schema(&expected).map_err(sqlite)? {
        return Err(format!("the store's tables do not match format {FORMAT}"));
    }
    let mode: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(sqlite)?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(format!("the store's journal mode is {mode}, expected wal"));
    }
    let vacuum: i64 = connection
        .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
        .map_err(sqlite)?;
    if vacuum != AUTO_VACUUM_INCREMENTAL {
        return Err(format!(
            "the store's auto_vacuum is {vacuum}, expected {AUTO_VACUUM_INCREMENTAL}"
        ));
    }
    Ok(())
}

/// The longest any one statement waits for a lock held by another process. An export that waits
/// longer fails with 500 and its sender resends it.
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(500);

/// How long after the last work on an export the writer returns freed memory.
const RELEASE_MEMORY_AFTER: Duration = Duration::from_millis(250);
/// How often the writer wakes with nothing queued, to save the refusal counts and notice a
/// memory release that a refused export asked for.
const IDLE_WAKE: Duration = Duration::from_millis(250);

/// The writer's loop. Besides stored exports it does work it decides on itself between them,
/// instead of taking it from the export queue: saving refusal counts and returning freed memory
/// once idle. Retention steps join it in a later change.
fn run(
    mut connection: Connection,
    inbox: mpsc::Receiver<Job>,
    losses: SharedLosses,
    release: &MemoryRelease,
    stopping: &AtomicBool,
) {
    loop {
        let wait = release.due().map_or(IDLE_WAKE, |at| {
            at.saturating_duration_since(Instant::now()).min(IDLE_WAKE)
        });
        match inbox.recv_timeout(wait) {
            // Once stopping, queued exports are dropped unanswered; see `Writer::close`.
            Ok(_) if stopping.load(Ordering::SeqCst) => {}
            Ok(Job::Spans(spans, reply)) => {
                let result =
                    store_spans(&mut connection, &spans).map_err(|error| error.to_string());
                drop(spans);
                let _ = reply.send(result);
                release.request();
            }
            Ok(Job::Logs(logs, reply)) => {
                let result = store_logs(&mut connection, &logs).map_err(|error| error.to_string());
                drop(logs);
                let _ = reply.send(result);
                release.request();
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                save_losses(&connection, &losses);
                if let Err((_, error)) = connection.close() {
                    log::error(
                        "closing the store failed",
                        &[("error", error.to_string().into())],
                    );
                }
                return;
            }
        }
        if stopping.load(Ordering::SeqCst) {
            continue;
        }
        save_losses(&connection, &losses);
        if release.take_if_due() {
            // The page cache refills from the file on the next export; an idle collector need not
            // hold it.
            if let Err(error) = connection.execute_batch("PRAGMA shrink_memory") {
                log::warn(
                    "releasing the store's cache failed",
                    &[("error", error.to_string().into())],
                );
            }
            release_memory();
        }
    }
}

/// How many malloc arenas glibc may use. By default it makes up to eight per core, roughly one
/// per thread that allocates, and memory freed in an arena that still holds live allocations is
/// hard to return. Measured with the memory scenario's burst, one arena returned 98% of the
/// burst in every run, sequential or four at once; two returned 66-99%; glibc's default returned
/// under half in some runs.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
const MALLOC_ARENAS: i32 = 1;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
unsafe extern "C" {
    fn mallopt(param: i32, value: i32) -> i32;
    fn malloc_trim(pad: usize) -> i32;
}

/// Cap glibc's malloc arenas. Called once, before any other thread starts.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub fn limit_memory_arenas() {
    const M_ARENA_MAX: i32 = -8;
    // SAFETY: mallopt takes no pointers; it runs before any other thread exists.
    unsafe {
        mallopt(M_ARENA_MAX, MALLOC_ARENAS);
    }
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
pub fn limit_memory_arenas() {}

/// Return freed heap memory to the system. glibc keeps freed memory in its arenas; without this
/// a burst of exports leaves the collector's resident memory near its peak.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn release_memory() {
    // SAFETY: malloc_trim takes no pointers and may be called from any thread.
    unsafe {
        malloc_trim(0);
    }
}

/// Other platforms' allocators are not measured yet; they return memory on their own schedule.
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn release_memory() {}

fn save_losses(connection: &Connection, losses: &SharedLosses) {
    let counts = {
        let mut book = lock(losses);
        if !book.unsaved {
            return;
        }
        book.unsaved = false;
        book.counts.clone()
    };
    let text = serde_json::to_string(&counts).unwrap_or_default();
    if let Err(error) = connection.execute("INSERT INTO meta (key, value) VALUES ('losses', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [text]) {
        log::error("saving the refusal counts failed", &[("error", error.to_string().into())]);
        lock(losses).unsaved = true;
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// A resource's id, found or created. Resources have no age; see `SCHEMA`.
fn resource_id(transaction: &Transaction, resource: &ResourceRow) -> rusqlite::Result<i64> {
    let found = transaction
        .prepare_cached("SELECT id FROM resources WHERE attributes_json = ?1")?
        .query_row([&resource.attributes_json], |row| row.get(0))
        .optional()?;
    match found {
        Some(id) => Ok(id),
        None => transaction
            .prepare_cached("INSERT INTO resources (attributes_json, service_name) VALUES (?1, ?2) RETURNING id")?
            .query_row(params![resource.attributes_json, resource.service_name], |row| row.get(0)),
    }
}

/// Delete a resource nothing refers to any more. Every delete or update that can drop a
/// resource's last reference calls this in the same transaction, so a resource exists exactly
/// while a span or log refers to it.
pub fn remove_resource_if_unreferenced(
    transaction: &Transaction,
    resource: i64,
) -> rusqlite::Result<bool> {
    let removed = transaction
        .prepare_cached(
            "DELETE FROM resources WHERE id = ?1
               AND NOT EXISTS (SELECT 1 FROM spans WHERE resource = ?1)
               AND NOT EXISTS (SELECT 1 FROM logs WHERE resource = ?1)",
        )?
        .execute([resource])?;
    Ok(removed > 0)
}

/// The stored columns of one span, to compare with a resent copy.
type StoredSpan = (
    Option<Vec<u8>>,
    i64,
    Option<String>,
    String,
    Option<i64>,
    i64,
    i64,
    i64,
    String,
    Option<String>,
);

fn same_span(stored: &StoredSpan, span: &SpanRow, resource: i64) -> bool {
    stored.0.as_deref() == span.parent_span_id.as_ref().map(|id| id.as_slice())
        && stored.1 == resource
        && stored.2 == span.scope_name
        && stored.3 == span.name
        && stored.4 == span.kind
        && stored.5 == span.start_ns
        && stored.6 == span.end_ns
        && stored.7 == span.status
        && stored.8 == span.attributes_json
        && stored.9 == span.events_json
}

fn is_running(span: &SpanRow) -> bool {
    span.end_ns <= 0 || span.end_ns < span.start_ns
}

/// A trace's summary row, held while an export changes it and written once at the end.
struct Summary {
    id: i64,
    service_name: String,
    root_name: Option<String>,
    root_started_ns: Option<i64>,
    started_ns: i64,
    ended_ns: i64,
    span_count: i64,
    error_count: i64,
    running_count: i64,
    /// Set when the export replaced a span that was, or became, the trace's earliest, latest or
    /// root span. Only reading all of the trace's spans can repair that.
    recompute: bool,
    written: bool,
}

impl Summary {
    /// Count a span added to the trace. The root is the earliest span without a parent; until
    /// one arrives, the trace takes the service of its earliest span. On equal start times the
    /// span stored first wins, matching `recompute_summary`.
    fn add(&mut self, span: &SpanRow, service: &str) {
        let first = self.span_count == 0;
        let earliest = first || span.start_ns < self.started_ns;
        if span.parent_span_id.is_none()
            && self.root_started_ns.is_none_or(|root| span.start_ns < root)
        {
            self.root_name = Some(span.name.clone());
            self.root_started_ns = Some(span.start_ns);
            self.service_name = service.to_owned();
        } else if self.root_started_ns.is_none() && earliest {
            self.service_name = service.to_owned();
        }
        if earliest {
            self.started_ns = span.start_ns;
        }
        if first || span.end_ns > self.ended_ns {
            self.ended_ns = span.end_ns;
        }
        self.span_count += 1;
        self.error_count += span.status;
        self.running_count += i64::from(is_running(span));
        self.written = true;
    }

    /// Apply a stored span's replacement without reading the trace's other spans, when neither
    /// copy is or could become the trace's root, its earliest span or its latest. Returns false
    /// when it could, and the trace must be recomputed. Ties count as could, so the result always
    /// matches `recompute_summary`'s choice by start time, then storage order.
    fn replace(&mut self, old: &StoredSpan, new: &SpanRow) -> bool {
        let (old_parent, old_start, old_end, old_status) = (&old.0, old.5, old.6, old.7);
        if old_parent.is_none()
            || new.parent_span_id.is_none()
            || old_start <= self.started_ns
            || new.start_ns <= self.started_ns
            || old_end >= self.ended_ns
        {
            return false;
        }
        let old_running = old_end <= 0 || old_end < old_start;
        self.error_count += new.status - old_status;
        self.running_count += i64::from(is_running(new)) - i64::from(old_running);
        self.ended_ns = self.ended_ns.max(new.end_ns);
        self.written = true;
        true
    }
}

fn load_summary(
    transaction: &Transaction,
    trace_id: &[u8; 16],
) -> rusqlite::Result<Option<Summary>> {
    transaction
        .prepare_cached(
            "SELECT id, service_name, root_name, root_started_ns, started_ns, ended_ns, span_count, error_count, running_count
             FROM traces WHERE trace_id = ?1",
        )?
        .query_row([trace_id.as_slice()], |row| {
            Ok(Summary {
                id: row.get(0)?,
                service_name: row.get(1)?,
                root_name: row.get(2)?,
                root_started_ns: row.get(3)?,
                started_ns: row.get(4)?,
                ended_ns: row.get(5)?,
                span_count: row.get(6)?,
                error_count: row.get(7)?,
                running_count: row.get(8)?,
                recompute: false,
                written: false,
            })
        })
        .optional()
}

/// Store one export's spans in one transaction and return how many it held. Decoding refuses an
/// export with an invalid id, so every span here has valid ids and is counted.
///
/// A span already stored with the same columns is counted and not written, so a resent export
/// costs one indexed read per span. A span stored with different columns is replaced. A trace's
/// summary is updated from the spans this export adds, without reading its other spans.
pub fn store_spans(connection: &mut Connection, export: &Spans) -> rusqlite::Result<usize> {
    let now = now_ms();
    let transaction = connection.transaction()?;
    // Traces this export touched, by id, in the order first seen; `None` for a trace not stored.
    let mut traces: HashMap<[u8; 16], Option<Summary>> = HashMap::new();
    let mut counted = 0;
    for (resource, spans) in &export.groups {
        // Found once per resource per export; created only when a span that refers to it is
        // written.
        let mut resource_known: Option<Option<i64>> = None;
        for span in spans {
            counted += 1;
            if let std::collections::hash_map::Entry::Vacant(entry) = traces.entry(span.trace_id) {
                entry.insert(load_summary(&transaction, &span.trace_id)?);
            }
            let known = match resource_known {
                Some(known) => known,
                None => {
                    let found = transaction
                        .prepare_cached("SELECT id FROM resources WHERE attributes_json = ?1")?
                        .query_row([&resource.attributes_json], |row| row.get::<_, i64>(0))
                        .optional()?;
                    resource_known = Some(found);
                    found
                }
            };
            let summary_id = traces
                .get(&span.trace_id)
                .and_then(|summary| summary.as_ref().map(|summary| summary.id));
            let stored: Option<StoredSpan> = match summary_id {
                Some(trace) => transaction
                    .prepare_cached(
                        "SELECT parent_span_id, resource, scope_name, name, kind, start_ns, end_ns, status, attributes_json, events_json
                         FROM spans WHERE trace = ?1 AND span_id = ?2",
                    )?
                    .query_row(params![trace, span.span_id.as_slice()], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?))
                    })
                    .optional()?,
                None => None,
            };
            if let (Some(stored), Some(resource_id)) = (&stored, known)
                && same_span(stored, span, resource_id)
            {
                continue;
            }
            let resource_id = match known {
                Some(id) => id,
                None => {
                    let id = resource_id(&transaction, resource)?;
                    resource_known = Some(Some(id));
                    id
                }
            };
            let slot = traces.get_mut(&span.trace_id).expect("loaded above");
            let summary = match slot {
                Some(summary) => summary,
                None => {
                    let id: i64 = transaction
                        .prepare_cached(
                            "INSERT INTO traces (trace_id, service_name, started_ns, ended_ns, last_seen_ms, span_count, error_count, running_count)
                             VALUES (?1, '', 0, 0, ?2, 0, 0, 0) RETURNING id",
                        )?
                        .query_row(params![span.trace_id.as_slice(), now], |row| row.get(0))?;
                    slot.insert(Summary {
                        id,
                        service_name: String::new(),
                        root_name: None,
                        root_started_ns: None,
                        started_ns: 0,
                        ended_ns: 0,
                        span_count: 0,
                        error_count: 0,
                        running_count: 0,
                        recompute: false,
                        written: false,
                    })
                }
            };
            let values = params![
                summary.id,
                span.span_id.as_slice(),
                span.parent_span_id.as_ref().map(|id| id.as_slice()),
                resource_id,
                span.scope_name,
                span.name,
                span.kind,
                span.start_ns,
                span.end_ns,
                span.status,
                span.attributes_json,
                span.events_json,
            ];
            if stored.is_some() {
                transaction
                    .prepare_cached(
                        "UPDATE spans SET parent_span_id = ?3, resource = ?4, scope_name = ?5, name = ?6, kind = ?7, start_ns = ?8,
                           end_ns = ?9, status = ?10, attributes_json = ?11, events_json = ?12
                         WHERE trace = ?1 AND span_id = ?2",
                    )?
                    .execute(values)?;
                if let Some(old) = &stored
                    && !summary.replace(old, span)
                {
                    summary.recompute = true;
                }
                summary.written = true;
                if let Some(previous) = stored
                    .as_ref()
                    .map(|stored| stored.1)
                    .filter(|previous| *previous != resource_id)
                {
                    remove_resource_if_unreferenced(&transaction, previous)?;
                }
            } else {
                transaction
                    .prepare_cached(
                        "INSERT INTO spans (trace, span_id, parent_span_id, resource, scope_name, name, kind, start_ns, end_ns, status, attributes_json, events_json)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    )?
                    .execute(values)?;
                summary.add(span, &resource.service_name);
            }
        }
    }
    for summary in traces
        .into_values()
        .flatten()
        .filter(|summary| summary.written)
    {
        if summary.recompute {
            recompute_summary(&transaction, summary.id, now)?;
        } else {
            transaction
                .prepare_cached(
                    "UPDATE traces SET service_name = ?2, root_name = ?3, root_started_ns = ?4, started_ns = ?5, ended_ns = ?6,
                       last_seen_ms = ?7, span_count = ?8, error_count = ?9, running_count = ?10 WHERE id = ?1",
                )?
                .execute(params![
                    summary.id,
                    summary.service_name,
                    summary.root_name,
                    summary.root_started_ns,
                    summary.started_ns,
                    summary.ended_ns,
                    now,
                    summary.span_count,
                    summary.error_count,
                    summary.running_count,
                ])?;
        }
    }
    transaction.commit()?;
    Ok(counted)
}

/// Recompute a trace's summary from all its spans. Needed only after a span was replaced.
fn recompute_summary(transaction: &Transaction, trace: i64, now: i64) -> rusqlite::Result<()> {
    let (spans, errors, running, started, ended): (i64, i64, i64, i64, i64) = transaction
        .prepare_cached(
            "SELECT count(*), total(status), total(end_ns <= 0 OR end_ns < start_ns), min(start_ns), max(end_ns)
             FROM spans WHERE trace = ?1",
        )?
        .query_row([trace], |row| Ok((row.get(0)?, row.get::<_, f64>(1)? as i64, row.get::<_, f64>(2)? as i64, row.get(3)?, row.get(4)?)))?;
    let root: Option<(String, i64, String)> = transaction
        .prepare_cached(
            "SELECT spans.name, spans.start_ns, resources.service_name FROM spans JOIN resources ON resources.id = spans.resource
             WHERE spans.trace = ?1 AND spans.parent_span_id IS NULL ORDER BY spans.start_ns, spans.id LIMIT 1",
        )?
        .query_row([trace], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    let (root_name, root_started, service) = match root {
        Some((name, started, service)) => (Some(name), Some(started), service),
        None => (
            None,
            None,
            transaction
                .prepare_cached(
                    "SELECT resources.service_name FROM spans JOIN resources ON resources.id = spans.resource
                     WHERE spans.trace = ?1 ORDER BY spans.start_ns, spans.id LIMIT 1",
                )?
                .query_row([trace], |row| row.get(0))?,
        ),
    };
    transaction
        .prepare_cached(
            "UPDATE traces SET service_name = ?2, root_name = ?3, root_started_ns = ?4, started_ns = ?5, ended_ns = ?6,
               last_seen_ms = ?7, span_count = ?8, error_count = ?9, running_count = ?10 WHERE id = ?1",
        )?
        .execute(params![trace, service, root_name, root_started, started, ended, now, spans, errors, running])?;
    Ok(())
}

/// Store one export's log records in one transaction. Logs have no identity in OTLP, so a resent
/// export is stored again.
pub fn store_logs(connection: &mut Connection, export: &Logs) -> rusqlite::Result<usize> {
    let now = now_ms();
    let transaction = connection.transaction()?;
    let mut counted = 0;
    for (resource, logs) in &export.groups {
        if logs.is_empty() {
            continue;
        }
        let resource_id = resource_id(&transaction, resource)?;
        let mut insert = transaction.prepare_cached(
            "INSERT INTO logs (trace_id, span_id, resource, scope_name, severity_text, time_ns, seen_ms, body, attributes_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        for log in logs {
            insert.execute(params![
                log.trace_id.as_ref().map(|id| id.as_slice()),
                log.span_id.as_ref().map(|id| id.as_slice()),
                resource_id,
                log.scope_name,
                log.severity_text,
                log.time_ns,
                now,
                log.body,
                log.attributes_json,
            ])?;
            counted += 1;
        }
    }
    transaction.commit()?;
    Ok(counted)
}
