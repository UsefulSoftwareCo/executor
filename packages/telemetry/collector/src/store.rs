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
use crate::retention::{self, Limits};

/// The store's format, kept in `PRAGMA user_version`. Raise it with every change to `SCHEMA`.
/// A store of another format is replaced, not migrated: see `open`.
pub const FORMAT: i64 = 2;

/// Marks a SQLite file as a telemetry store, in `PRAGMA application_id` ("EXTC"). A file with
/// another application id belongs to something else and is never replaced.
pub const APPLICATION_ID: i64 = 0x4558_5443;

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
/// - A trace's `first_seen_ms` is when its first span was written. Size eviction removes what
///   arrived first, traces by rowid and logs by rowid, and compares the two by these times.
/// - At most one trace is being evicted at a time; `meta` key `evicting` holds its rowid. Its
///   rows are deleted in bounded steps and queries treat it as already gone. See `retention`.
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
  first_seen_ms INTEGER NOT NULL,
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

pub enum Export {
    Spans(Spans),
    Logs(Logs),
}

/// An export queued for the writer, with the reply its sender waits for.
pub struct Job {
    pub export: Export,
    pub reply: oneshot::Sender<Result<usize, String>>,
    /// `Shared::maintenance_micros` when the export was queued, to measure how long it then waited
    /// behind retention steps.
    pub maintenance_at_queue: u64,
}

/// The handle the HTTP side uses to reach the writer thread.
pub struct Writer {
    jobs: SyncSender<Job>,
    stopping: Arc<AtomicBool>,
    finished: mpsc::Receiver<()>,
    /// The directory and its lock, held until the process exits.
    owned: Owned,
    thread: JoinHandle<()>,
}

/// The store's figures as the writer last saw them, for `/api/ingest` and admission.
#[derive(Clone, Debug, Default)]
pub struct Figures {
    /// Bytes of pages holding data: what `--max-store-mb` bounds.
    pub used_bytes: u64,
    /// `used_bytes` as the writer left it after its eviction for the last export: what admission
    /// judges, so an export is not refused for the growth the previous one caused before the
    /// eviction it is owed has run.
    pub settled_used_bytes: u64,
    /// The database file's size: pages in use and free pages.
    pub file_bytes: u64,
    /// The write-ahead log's size on disk.
    pub wal_bytes: u64,
    pub max_bytes: u64,
    pub retention_hours: u64,
    /// Over the bound and evicting until the low-water mark.
    pub draining: bool,
    /// Retention has work it has not done yet: evicting or returning free pages. As the writer
    /// last found it; see `next_expiry_ms`.
    pub maintenance_pending: bool,
    /// When the oldest trace or log stored will be older than the retention period, in ms. An
    /// idle writer looks for that work only when it next wakes, so from this time on the status
    /// counts maintenance as pending until the writer publishes again (`Figures::pending_at`).
    pub next_expiry_ms: Option<i64>,
    /// Periods of eviction that evicted at least one trace, since the collector started.
    pub eviction_passes: u64,
    pub evicted_traces: u64,
    pub evicted_spans: u64,
    pub evicted_logs: u64,
    pub steps: u64,
    /// The longest one retention step held the writer.
    pub longest_step_micros: u64,
    /// The longest one export waited in the queue while retention steps ran.
    pub longest_export_wait_micros: u64,
    /// The write-ahead log is over `WAL_REFUSE_BYTES`: exports are refused until a checkpoint
    /// empties it.
    pub wal_full: bool,
    /// Truncating checkpoints that could not empty the log because a reader was using it.
    pub checkpoints_blocked: u64,
    /// Truncating checkpoints that emptied the log.
    pub wal_emptied: u64,
}

impl Figures {
    /// Whether retention has work owed when the wall clock reads `wall_ms`: the writer said so
    /// when it last published, or a stored row has expired since. The writer publishes again once
    /// it has done that work, with the next expiry, so the status never reports finished while
    /// age eviction is owed.
    ///
    /// The wall clock is compared with the expiry directly. The writer ages rows by its
    /// `IngestClock`, which is never behind the wall clock, but it publishes only after it has
    /// looked for work at that clock: a row expired by the clock it published is work it found,
    /// so `maintenance_pending` is set, and an expiry it publishes with none found is later than
    /// that clock. So the published clock can pass an expiry only when the status already says
    /// pending.
    pub fn pending_at(&self, wall_ms: i64) -> bool {
        self.maintenance_pending || self.next_expiry_ms.is_some_and(|at| wall_ms >= at)
    }
}

/// A reading of the wall clock, in milliseconds since the epoch.
pub type WallClock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// What the writer shares with the HTTP side besides the export queue.
pub struct Shared {
    figures: Mutex<Figures>,
    /// Time spent in retention steps since the writer started, in microseconds.
    pub maintenance_micros: std::sync::atomic::AtomicU64,
    /// The wall clock the writer stamps and ages rows by and the status reads: the system's,
    /// unless a test gives its own (`Shared::with_clock`).
    wall: WallClock,
}

impl Default for Shared {
    fn default() -> Self {
        Shared::with_clock(Arc::new(now_ms))
    }
}

impl Shared {
    /// With `wall` as the wall clock, for the library tests.
    pub fn with_clock(wall: WallClock) -> Shared {
        Shared {
            figures: Mutex::new(Figures::default()),
            maintenance_micros: std::sync::atomic::AtomicU64::new(0),
            wall,
        }
    }

    /// The wall clock's reading now.
    pub fn wall_ms(&self) -> i64 {
        (self.wall)()
    }

    /// Whether `/api/ingest` says maintenance is pending now (`Figures::pending_at`).
    pub fn pending_now(&self) -> bool {
        self.figures().pending_at(self.wall_ms())
    }

    pub fn figures(&self) -> Figures {
        self.figures
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn update(&self, change: impl FnOnce(&mut Figures)) {
        change(
            &mut self
                .figures
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
    }
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
    /// The store's directory, resolved.
    pub fn data(&self) -> &Path {
        &self.owned.data
    }

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

/// The lock file in `--data`: held exclusively for the collector's life, so one collector uses a
/// directory at a time. Created if missing and never removed.
pub const LOCK_FILE: &str = "telemetry.lock";

/// The store a running collector holds: its directory, resolved once, and the lock on it.
pub struct Owned {
    pub data: PathBuf,
    _lock: std::fs::File,
}

/// Resolve `--data` (creating it if missing) and take its lock before reading anything else in
/// it. Fails, changing nothing, when another collector holds it.
pub fn own(data: &Path) -> Result<Owned, String> {
    std::fs::create_dir_all(data)
        .map_err(|error| format!("cannot create {}: {error}", data.display()))?;
    let data = std::fs::canonicalize(data)
        .map_err(|error| format!("cannot resolve {}: {error}", data.display()))?;
    let path = data.join(LOCK_FILE);
    regular_or_absent(&path)?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    match lock.try_lock() {
        Ok(()) => Ok(Owned { data, _lock: lock }),
        Err(std::fs::TryLockError::WouldBlock) => Err(format!(
            "another collector is using {}; this one changes nothing and exits",
            data.display()
        )),
        Err(std::fs::TryLockError::Error(error)) => {
            Err(format!("cannot lock {}: {error}", path.display()))
        }
    }
}

/// Open or create the store in the directory `owned` holds and start its writer. See `open`.
pub fn start(
    owned: Owned,
    queue: usize,
    losses: SharedLosses,
    release: Arc<MemoryRelease>,
    limits: Limits,
    shared: Arc<Shared>,
) -> Result<Writer, String> {
    let database = database_path(&owned.data);
    let connection = open(&database)?;
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
    // Start-up's own reads fail the start: retrying is for the work after it is serving.
    let clock = IngestClock::restore(&connection)
        .map_err(|error| format!("cannot read the store: {error}"))?;
    let mut state = WriterState {
        connection,
        database,
        limits,
        shared,
        work: Work::default(),
        pass_counted: false,
        failed_until: None,
        last_failure_log: None,
        last_truncate: None,
        clock,
    };
    let now = state.clock.now(state.shared.wall_ms());
    let (evict, vacuum) = retention::work(&state.connection, &limits, now)
        .map_err(|error| format!("cannot read the store: {error}"))?;
    state.work = Work { evict, vacuum };
    retention::Size::read(&state.connection)
        .and_then(|_| retention::draining(&state.connection))
        .and_then(|_| retention::next_expiry_ms(&state.connection, &limits))
        .map_err(|error| format!("cannot read the store: {error}"))?;
    state.publish();
    let writer = Writer {
        jobs,
        stopping: stopping.clone(),
        finished,
        owned,
        thread: std::thread::Builder::new()
            .name("store-writer".to_owned())
            .stack_size(WRITER_STACK)
            .spawn(move || {
                run(state, inbox, losses, &release, &stopping);
                let _ = done.send(());
            })
            .map_err(|error| format!("cannot start the writer: {error}"))?,
    };
    Ok(writer)
}

/// The names SQLite itself manages beside the database: its write-ahead log, the log's index and
/// a rollback journal.
pub fn companions(database: &Path) -> [PathBuf; 3] {
    ["-wal", "-shm", "-journal"].map(|suffix| {
        let mut name = database.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    })
}

/// Fail, changing nothing, unless `path` is absent or a regular file. A symbolic link is refused
/// whatever it points at.
fn regular_or_absent(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot inspect {}: {error}", path.display())),
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "{} is a symbolic link; the collector changes nothing",
            path.display()
        )),
        Ok(metadata) if !metadata.is_file() => Err(format!(
            "{} is not a regular file; the collector changes nothing",
            path.display()
        )),
        Ok(_) => Ok(()),
    }
}

/// What the database file is, judged from its first 100 bytes with plain file reads, before
/// SQLite opens it: SQLite recovers, checkpoints and deletes companions as it opens and closes a
/// file, so a file that is not ours must never reach it.
enum Header {
    /// Missing or empty: a new store, or a first start cut off before it wrote anything.
    New,
    /// SQLite with this collector's application id.
    Ours,
    /// Anything else, with why.
    NotOurs(String),
}

fn read_header(path: &Path) -> Result<Header, String> {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Header::New),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let mut header = Vec::with_capacity(100);
    file.by_ref()
        .take(100)
        .read_to_end(&mut header)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if header.is_empty() {
        return Ok(Header::New);
    }
    if header.len() < 100 || !header.starts_with(b"SQLite format 3\0") {
        return Ok(Header::NotOurs("it is not a SQLite database".to_owned()));
    }
    let application = i32::from_be_bytes([header[68], header[69], header[70], header[71]]);
    if application == 0 && never_held_a_table(&header, path)? {
        return Ok(Header::New);
    }
    if i64::from(application) != APPLICATION_ID {
        return Ok(Header::NotOurs(format!(
            "it is a SQLite database with application id {application}, not a telemetry store"
        )));
    }
    Ok(Header::Ours)
}

/// Whether a SQLite file without an application id is one page that never held a table: what a
/// first start cut off just after setting incremental auto-vacuum leaves, since SQLite writes
/// that setting before the application id can be set and will not change it once the first page
/// exists. Read from the header only: one page, the file at most that long (a first write cut
/// off part way leaves less), a schema cookie of 0
/// (SQLite raises it with every change to the schema; only a program that writes the header
/// itself could set it back), format 0, rollback mode, and no
/// write-ahead log beside it. Such a file holds no data, and neither can a rollback journal
/// beside it. An empty database another program created at this name looks the same, and is
/// taken over.
fn never_held_a_table(header: &[u8], path: &Path) -> Result<bool, String> {
    let word = |at: usize| {
        u32::from_be_bytes([header[at], header[at + 1], header[at + 2], header[at + 3]])
    };
    let page_size = match u16::from_be_bytes([header[16], header[17]]) {
        1 => 65_536,
        size => u64::from(size),
    };
    let length = std::fs::metadata(path)
        .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?
        .len();
    let [wal, _, _] = companions(path);
    Ok(word(28) == 1
        && length <= page_size
        && word(40) == 0
        && word(60) == 0
        && header[18] == 1
        && header[19] == 1
        && !wal.exists())
}

/// Open the store at `path`, creating it when new.
///
/// - `path` and its companions must each be absent or a regular file; a symbolic link or
///   anything else is refused, and SQLite is told not to follow a link either.
/// - The first bytes decide what the file is, before SQLite opens it: missing, empty, or one page
///   that never held a table (`never_held_a_table`) is new; anything else but SQLite carrying
///   `APPLICATION_ID` is not ours, and is refused with every file left exactly as it was.
/// - Then SQLite opens it, and recovers it if a start was cut off. What recovery leaves decides
///   again (`open_store`): creation is re-entrant, so a store whose tables were never created is
///   finished from whatever step it reached.
/// - A store of ours in another format, or whose tables do not match, is emptied in place in one
///   transaction (see `reset`); one log line says why.
/// - Before it is used, the store must carry the application id, the format and the schema this
///   collector writes (`finish`): nothing is served that the next start would refuse.
///
/// The collector's own code removes no file. Any error fails the start and the supervisor retries.
pub fn open(path: &Path) -> Result<Connection, String> {
    regular_or_absent(path)?;
    for companion in companions(path) {
        regular_or_absent(&companion)?;
    }
    match read_header(path)? {
        Header::NotOurs(why) => Err(format!("{}: {why}; it is left as it is", path.display())),
        Header::New | Header::Ours => open_store(connect(path)?, path),
    }
}

fn connect(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| error.to_string())?;
    // The collector is the store's only writer, so a lock is held only by another process, such
    // as someone inspecting the file. No single wait may outlast the shutdown budget.
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn sqlite(error: rusqlite::Error) -> String {
    error.to_string()
}

/// Objects in the schema that are the collector's: everything but SQLite's own `sqlite_` tables
/// and indexes (statistics, sequences, automatic indexes), which SQLite manages and which neither
/// the comparison nor the reset counts.
const OURS: &str = "substr(name, 1, 7) != 'sqlite_'";

/// The store as SQLite sees it once it has opened and recovered the file.
fn open_store(mut connection: Connection, path: &Path) -> Result<Connection, String> {
    let read = |connection: &Connection, sql: &str| -> Result<i64, String> {
        connection
            .query_row(sql, [], |row| row.get(0))
            .map_err(sqlite)
    };
    // The first statement recovers a hot journal or a log; everything below is read after it.
    let objects = read(
        &connection,
        &format!("SELECT count(*) FROM sqlite_schema WHERE {OURS}"),
    )?;
    let application = read(&connection, "PRAGMA application_id")?;
    let version = read(&connection, "PRAGMA user_version")?;
    if objects == 0 && version == 0 && (application == 0 || application == APPLICATION_ID) {
        // No table was ever created: a new store, or a first start cut off before its tables.
        return create(connection, path);
    }
    if application != APPLICATION_ID {
        return Err(format!(
            "{}: once opened, it is a SQLite database with application id {application}, not a telemetry store; it is left as it is",
            path.display()
        ));
    }
    let auto_vacuum = read(&connection, "PRAGMA auto_vacuum")?;
    if auto_vacuum != AUTO_VACUUM_INCREMENTAL {
        return Err(format!(
            "{}: the store's auto_vacuum is {auto_vacuum}, not {AUTO_VACUUM_INCREMENTAL}, which only rebuilding the file could change; it is not emptied",
            path.display()
        ));
    }
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(sqlite)?;
    if mismatch(&connection)?.is_some() {
        reset(&mut connection, path)?;
    }
    finish(connection)
}

/// Create the store, or finish creating one whose first start was cut off: each step is done
/// unless it already is, in order, so the file is recognisably ours before it holds anything.
/// Incremental auto-vacuum, which SQLite fixes with the first page; the application id, durably,
/// in a rollback-mode transaction; WAL mode; then the tables and the format in one transaction.
fn create(mut connection: Connection, path: &Path) -> Result<Connection, String> {
    let read = |connection: &Connection, sql: &str| -> Result<i64, String> {
        connection
            .query_row(sql, [], |row| row.get(0))
            .map_err(sqlite)
    };
    if read(&connection, "PRAGMA page_count")? == 0 {
        connection
            .pragma_update(None, "auto_vacuum", AUTO_VACUUM_INCREMENTAL)
            .map_err(sqlite)?;
    }
    let auto_vacuum = read(&connection, "PRAGMA auto_vacuum")?;
    if auto_vacuum != AUTO_VACUUM_INCREMENTAL {
        return Err(format!(
            "{}: an empty store whose auto_vacuum is {auto_vacuum}, not {AUTO_VACUUM_INCREMENTAL}, which only rebuilding the file could change; it is not used",
            path.display()
        ));
    }
    if read(&connection, "PRAGMA application_id")? != APPLICATION_ID {
        connection
            .pragma_update(None, "application_id", APPLICATION_ID)
            .map_err(sqlite)?;
    }
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(sqlite)?;
    let transaction = connection.transaction().map_err(sqlite)?;
    transaction.execute_batch(SCHEMA).map_err(sqlite)?;
    transaction
        .pragma_update(None, "user_version", FORMAT)
        .map_err(sqlite)?;
    transaction.commit().map_err(sqlite)?;
    finish(connection)
}

/// Why the store is not this format's, or `None` when it is: its `user_version`, then its schema
/// against this format's (the collector's own objects, not SQLite's). The reset checks its own
/// result with it before it commits; no reset is known to fail that check, since it drops every
/// object of the collector's and creates the schema, so it stays as the last line of defence.
/// Public so the library tests can check it directly.
pub fn mismatch(connection: &Connection) -> Result<Option<String>, String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sqlite)?;
    if version != FORMAT {
        return Ok(Some(format!(
            "the store has format {version}; this collector writes format {FORMAT}"
        )));
    }
    if !schema_matches(connection)? {
        return Ok(Some(format!(
            "the store's tables do not match format {FORMAT}"
        )));
    }
    Ok(None)
}

/// Empty a store of ours in place and give it this format's tables: one immediate transaction
/// that reads the format again inside it, drops every table, index, trigger and view of the
/// collector's, creates the schema, sets the format and checks the result before it commits. It
/// commits whole or not at all, so the old store is either kept or replaced; a result that does
/// not check is rolled back and fails the start with the store as it was. Nothing is removed and
/// there is no part-done state. Freed pages go back to the file system as retention returns free
/// pages (`retention::step`).
fn reset(connection: &mut Connection, path: &Path) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(sqlite)?;
    // Another start, or this one's retry, may already have done it.
    let Some(reason) = mismatch(&transaction)? else {
        return Ok(());
    };
    let objects: Vec<(String, String)> = transaction
        .prepare(&format!(
            "SELECT type, name FROM sqlite_schema WHERE {OURS}"
        ))
        .and_then(|mut statement| {
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .map_err(sqlite)?;
    // Views and triggers first; dropping a table drops its indexes.
    for kind in ["view", "trigger", "table"] {
        for (_, name) in objects.iter().filter(|(found, _)| found == kind) {
            let quoted = name.replace('"', "\"\"");
            transaction
                .execute_batch(&format!("DROP {kind} IF EXISTS \"{quoted}\""))
                .map_err(sqlite)?;
        }
    }
    transaction.execute_batch(SCHEMA).map_err(sqlite)?;
    transaction
        .pragma_update(None, "user_version", FORMAT)
        .map_err(sqlite)?;
    commit_checked(transaction, path)?;
    log::warn(
        "emptied the telemetry store and gave it this collector's format",
        &[
            ("path", path.display().to_string().into()),
            ("reason", reason.into()),
        ],
    );
    Ok(())
}

/// The reset's last step: commit `transaction` only if what it leaves is this format's
/// (`mismatch`), else roll it back, so the old store is kept. Public so the library tests can hand
/// it a transaction that does not check.
pub fn commit_checked(transaction: rusqlite::Transaction<'_>, path: &Path) -> Result<(), String> {
    if let Some(still) = mismatch(&transaction)? {
        // Dropping the transaction rolls everything back.
        drop(transaction);
        return Err(format!(
            "{}: emptying the store would not give it this collector's format ({still}); it is left as it was",
            path.display()
        ));
    }
    transaction.commit().map_err(sqlite)
}

/// The last step of every start, on the connection that will serve: check the store's
/// application id, format, schema and journal mode (`servable`), then set the connection's
/// settings. The store's auto-vacuum mode, which a store of ours must also have, is checked
/// earlier, where the store is opened (`open_store`): a store in another mode is refused before this.
/// Public so the library tests can hand it connections that must be refused.
pub fn finish(connection: Connection) -> Result<Connection, String> {
    servable(&connection)?;
    connection
        .execute_batch(
            "PRAGMA synchronous = NORMAL; PRAGMA journal_size_limit = 16777216; PRAGMA cache_size = -8192;",
        )
        .map_err(sqlite)?;
    Ok(connection)
}

/// Whether the store on `connection` is one the next start takes as it is: this collector's
/// application id, format and schema, in WAL mode. Checked last, on the connection that will
/// serve, before the listening line. No state the steps before it leave is known to fail it:
/// `open_store` refuses another application id, and creation and the reset produce the rest. It
/// stays as the last line of defence, so a store that would be refused is never served; public
/// so the library tests can check it directly.
pub fn servable(connection: &Connection) -> Result<(), String> {
    let application: i64 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(sqlite)?;
    if application != APPLICATION_ID {
        return Err(format!(
            "the store's application id is {application}, expected {APPLICATION_ID}"
        ));
    }
    if let Some(reason) = mismatch(connection)? {
        return Err(reason);
    }
    let mode: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(sqlite)?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(format!("the store's journal mode is {mode}, expected wal"));
    }
    Ok(())
}

/// One row of `sqlite_schema`: type, name, table and SQL.
type SchemaEntry = (String, String, String, Option<String>);

/// Whether the file holds exactly this format's schema, compared with the schema created in
/// memory: the collector's own objects, not SQLite's (`OURS`).
fn schema_matches(connection: &Connection) -> Result<bool, String> {
    let schema = |connection: &Connection| -> rusqlite::Result<Vec<SchemaEntry>> {
        connection
            .prepare(&format!(
                "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE {OURS} ORDER BY type, name"
            ))?
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect()
    };
    let expected = Connection::open_in_memory().map_err(sqlite)?;
    expected.execute_batch(SCHEMA).map_err(sqlite)?;
    Ok(schema(connection).map_err(sqlite)? == schema(&expected).map_err(sqlite)?)
}

/// The longest any one statement waits for a lock held by another process. An export that waits
/// longer fails with 500 and its sender resends it.
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(500);

/// How long after the last work on an export the writer returns freed memory.
const RELEASE_MEMORY_AFTER: Duration = Duration::from_millis(250);
/// How often the writer wakes with nothing queued, to save the refusal counts and notice a
/// memory release that a refused export asked for.
const IDLE_WAKE: Duration = Duration::from_millis(250);

/// Past this size the writer empties the write-ahead log with a truncating checkpoint.
pub const WAL_CHECKPOINT_BYTES: u64 = 8 * 1024 * 1024;
/// Past this size exports are refused and retention pauses until the log is emptied.
pub const WAL_REFUSE_BYTES: u64 = 32 * 1024 * 1024;
/// How long one truncating checkpoint waits for readers still using the log.
const TRUNCATE_WAIT: Duration = Duration::from_millis(50);
/// How often the writer tries to empty a log between the two sizes.
const TRUNCATE_EVERY: Duration = Duration::from_millis(250);

/// The writer thread's stack. Set explicitly, so `RUST_MIN_STACK` in the environment cannot
/// shrink it: no thread in this crate takes its stack size from the environment.
const WRITER_STACK: usize = 2 * 1024 * 1024;

/// After a step fails, how long the writer waits before the next one.
const RETRY_STEP_AFTER: Duration = Duration::from_secs(1);
/// How often a failing step is logged.
const STEP_FAILURE_LOG_INTERVAL: Duration = Duration::from_secs(60);
/// While evicting, the steps after an export free at least this many times the bytes the export
/// added, so eviction outpaces sustained ingest and a drain ends.
const EVICT_PER_GROWTH: u64 = 2;

/// What retention has left to do.
#[derive(Clone, Copy, Debug, Default)]
struct Work {
    evict: bool,
    vacuum: bool,
}

impl Work {
    fn any(&self) -> bool {
        self.evict || self.vacuum
    }
}

/// The writer thread's own state: its connection and retention's progress.
struct WriterState {
    connection: Connection,
    database: PathBuf,
    limits: Limits,
    shared: Arc<Shared>,
    work: Work,
    /// Whether the current period of eviction has been counted as a pass.
    pass_counted: bool,
    /// After a failed step, no step runs before this.
    failed_until: Option<Instant>,
    last_failure_log: Option<Instant>,
    /// When the writer last tried to empty the write-ahead log.
    last_truncate: Option<Instant>,
    /// What rows are stamped with and aged by.
    clock: IngestClock,
}

impl WriterState {
    fn check_work(&mut self) {
        let now = self.clock.now(self.shared.wall_ms());
        match retention::work(&self.connection, &self.limits, now) {
            Ok((evict, vacuum)) => self.work = Work { evict, vacuum },
            Err(error) => {
                self.failed(&error);
                self.work = Work::default();
            }
        }
        if !self.work.evict {
            self.pass_counted = false;
        }
    }

    fn may_step(&self) -> bool {
        self.work.any()
            && self
                .failed_until
                .is_none_or(|until| until <= Instant::now())
            && !self.wal_full()
    }

    fn wal_full(&self) -> bool {
        retention::wal_bytes(&self.database) > WAL_REFUSE_BYTES
    }

    /// Keep the write-ahead log bounded. SQLite's own checkpoints, run as transactions commit,
    /// copy the log into the database but start it again from the beginning only when a write
    /// begins with every frame copied and no reader holding a snapshot of the log. Readers that
    /// follow one another closely, each one short, can hold some snapshot at every moment, and
    /// the log then grows without end: on 13 Nov 2026 a load test grew it to 19 GB beside a
    /// 64 MB database with a reader that began a 5-second read as soon as the last one ended.
    ///
    /// So past `WAL_CHECKPOINT_BYTES` the writer runs a truncating checkpoint, which copies the
    /// rest of the log, waits at most `TRUNCATE_WAIT` for readers still using it, and empties
    /// the file. Past `WAL_REFUSE_BYTES` exports are refused and retention pauses, so nothing new
    /// is written to the log: a reader that starts then reads only the database, older readers
    /// end within their deadline, and the next attempt empties the log.
    fn settle_wal(&mut self) {
        let wal = retention::wal_bytes(&self.database);
        if wal <= WAL_CHECKPOINT_BYTES {
            return;
        }
        let full = wal > WAL_REFUSE_BYTES;
        if !full
            && self
                .last_truncate
                .is_some_and(|at| at.elapsed() < TRUNCATE_EVERY)
        {
            return;
        }
        self.last_truncate = Some(Instant::now());
        let started = Instant::now();
        let result = self.connection.busy_timeout(TRUNCATE_WAIT).and_then(|()| {
            self.connection
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    row.get::<_, i64>(0)
                })
        });
        let _ = self.connection.busy_timeout(BUSY_TIMEOUT);
        self.shared
            .maintenance_micros
            .fetch_add(started.elapsed().as_micros() as u64, Ordering::SeqCst);
        match result {
            Ok(0) => self.shared.update(|figures| figures.wal_emptied += 1),
            Ok(_) => self
                .shared
                .update(|figures| figures.checkpoints_blocked += 1),
            Err(error) => self.failed(&error),
        }
    }

    /// Run one retention step and record it. Returns the bytes in use it freed and whether it
    /// deleted any rows.
    fn step(&mut self) -> (u64, bool) {
        let before = retention::Size::read(&self.connection).map_or(0, |size| size.used_bytes());
        let started = Instant::now();
        let now = self.clock.now(self.shared.wall_ms());
        let result = retention::step(
            &mut self.connection,
            &self.limits,
            now,
            retention::STEP_ROWS,
        );
        let took = started.elapsed().as_micros() as u64;
        self.shared
            .maintenance_micros
            .fetch_add(took, Ordering::SeqCst);
        let done = match result {
            Ok(done) => {
                self.failed_until = None;
                done
            }
            Err(error) => {
                self.failed(&error);
                return (0, false);
            }
        };
        let count_pass = done.traces > 0 && !self.pass_counted;
        if count_pass {
            self.pass_counted = true;
        }
        self.shared.update(|figures| {
            figures.steps += 1;
            figures.longest_step_micros = figures.longest_step_micros.max(took);
            figures.evicted_traces += done.traces;
            figures.evicted_spans += done.spans;
            figures.evicted_logs += done.logs;
            figures.eviction_passes += u64::from(count_pass);
        });
        self.check_work();
        // A step that changed nothing has nothing more to do now.
        if done.rows() == 0 && done.vacuumed_pages == 0 {
            self.work = Work::default();
            self.pass_counted = false;
        }
        let after =
            retention::Size::read(&self.connection).map_or(before, |size| size.used_bytes());
        (before.saturating_sub(after), done.rows() > 0)
    }

    fn failed(&mut self, error: &rusqlite::Error) {
        self.failed_until = Some(Instant::now() + RETRY_STEP_AFTER);
        if self
            .last_failure_log
            .is_none_or(|at| at.elapsed() >= STEP_FAILURE_LOG_INTERVAL)
        {
            self.last_failure_log = Some(Instant::now());
            log::error(
                "a retention step failed; retrying",
                &[("error", error.to_string().into())],
            );
        }
    }

    fn publish(&self) {
        self.publish_figures(true);
    }

    /// Publish the store's figures; `settled` when the writer has finished the eviction it owes
    /// the last export.
    fn publish_figures(&self, settled: bool) {
        let size = retention::Size::read(&self.connection).unwrap_or_default();
        let draining = retention::draining(&self.connection).unwrap_or(false);
        let wal = retention::wal_bytes(&self.database);
        let wal_full = wal > WAL_REFUSE_BYTES;
        let limits = self.limits;
        let pending = self.work.any();
        // A store the writer cannot read now counts as owing work at once.
        let next_expiry = retention::next_expiry_ms(&self.connection, &limits).unwrap_or(Some(0));
        self.shared.update(|figures| {
            figures.used_bytes = size.used_bytes();
            if settled {
                figures.settled_used_bytes = size.used_bytes();
            }
            figures.file_bytes = size.file_bytes();
            figures.wal_bytes = wal;
            figures.max_bytes = limits.max_bytes;
            figures.retention_hours = (limits.retention_ms / 3_600_000) as u64;
            figures.draining = draining;
            figures.maintenance_pending = pending;
            figures.next_expiry_ms = next_expiry;
            figures.wal_full = wal_full;
        });
    }

    /// Store one export, then, when retention has eviction to do, run steps until they have freed
    /// `EVICT_PER_GROWTH` times what the export added, at least one step.
    fn store(&mut self, job: Job, stopping: &AtomicBool) {
        let waited = self
            .shared
            .maintenance_micros
            .load(Ordering::SeqCst)
            .saturating_sub(job.maintenance_at_queue);
        self.shared.update(|figures| {
            figures.longest_export_wait_micros = figures.longest_export_wait_micros.max(waited);
        });
        let before = retention::Size::read(&self.connection).map_or(0, |size| size.used_bytes());
        // One stamp for the whole export, later than every stamp before it.
        let stamp = self.clock.stamp(self.shared.wall_ms());
        let result = match &job.export {
            Export::Spans(spans) => store_spans_at(&mut self.connection, spans, stamp),
            Export::Logs(logs) => store_logs_at(&mut self.connection, logs, stamp),
        }
        .map_err(|error| error.to_string());
        drop(job.export);
        let after =
            retention::Size::read(&self.connection).map_or(before, |size| size.used_bytes());
        // The store's new size and the work it causes are published before the sender hears
        // its export was stored, so the first status it reads afterwards already shows the
        // retention still to do (`maintenancePending`), which stays set until it is done.
        self.check_work();
        self.publish_figures(false);
        let _ = job.reply.send(result);
        let owed = after.saturating_sub(before) * EVICT_PER_GROWTH;
        let mut freed = 0;
        while self.work.evict && self.may_step() && !stopping.load(Ordering::SeqCst) {
            let (bytes, deleted) = self.step();
            freed += bytes;
            if !deleted || freed >= owed {
                break;
            }
        }
    }
}

/// The writer's loop. Besides stored exports it does work it decides on itself between them,
/// instead of taking it from the export queue: retention steps, saving refusal counts and
/// returning freed memory once idle. With retention work outstanding it takes a step whenever no
/// export is queued, and after each export (see `WriterState::store`).
fn run(
    mut state: WriterState,
    inbox: mpsc::Receiver<Job>,
    losses: SharedLosses,
    release: &MemoryRelease,
    stopping: &AtomicBool,
) {
    loop {
        let busy = state.may_step() && !stopping.load(Ordering::SeqCst);
        let received = if busy {
            inbox.try_recv().map_err(|error| match error {
                mpsc::TryRecvError::Empty => RecvTimeoutError::Timeout,
                mpsc::TryRecvError::Disconnected => RecvTimeoutError::Disconnected,
            })
        } else {
            // With the log full, the writer tries again to empty it after each short wait.
            let wake = if state.wal_full() {
                TRUNCATE_WAIT
            } else {
                IDLE_WAKE
            };
            let wait = release.due().map_or(wake, |at| {
                at.saturating_duration_since(Instant::now()).min(wake)
            });
            inbox.recv_timeout(wait)
        };
        match received {
            // Once stopping, queued exports are dropped unanswered; see `Writer::close`.
            Ok(_) if stopping.load(Ordering::SeqCst) => {}
            Ok(job) => {
                state.store(job, stopping);
                release.request();
            }
            Err(RecvTimeoutError::Timeout) if busy => {
                state.step();
            }
            Err(RecvTimeoutError::Timeout) => state.check_work(),
            Err(RecvTimeoutError::Disconnected) => {
                save_losses(&state.connection, &losses);
                if let Err((_, error)) = state.connection.close() {
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
        state.settle_wal();
        state.publish();
        // Saving the counts writes to the log. While it is full, any write there keeps it from
        // being emptied: a reader that starts after it holds a snapshot of the log again. The
        // counts are saved once the log is emptied.
        if !state.wal_full() {
            save_losses(&state.connection, &losses);
        }
        if release.take_if_due() {
            // The page cache refills from the file on the next export; an idle collector need not
            // hold it.
            if let Err(error) = state.connection.execute_batch("PRAGMA shrink_memory") {
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

/// The clock rows are stamped with and retention ages them by. Each export takes one stamp for
/// all its rows, the wall clock but at least a millisecond after the stamp before it, so stamps
/// order exports by arrival, traces and logs alike, with no two exports alike: age retention
/// walks logs in rowid order and stops at the first one not yet expired, and size eviction
/// chooses between the oldest trace and the oldest log by their stamps, both right only while
/// stamps rise. After the host clock is set back, or forward and then corrected, stamps go on
/// from the latest one a millisecond an export until the wall clock passes them, so those rows
/// are kept that much longer; past a thousand exports a second they run ahead of the wall clock
/// by the excess. The clock is restored at start from the newest stamp still stored, so it never
/// goes back among the rows the store holds; a stamp whose rows were all evicted is not kept.
#[derive(Clone, Copy, Debug)]
pub struct IngestClock {
    last_ms: i64,
}

impl IngestClock {
    /// The clock as the store left it: the newest log's stamp and the newest trace's, each read at
    /// an index end.
    pub fn restore(connection: &Connection) -> rusqlite::Result<IngestClock> {
        let log: Option<i64> = connection
            .prepare_cached("SELECT seen_ms FROM logs ORDER BY id DESC LIMIT 1")?
            .query_row([], |row| row.get(0))
            .optional()?;
        let trace: Option<i64> = connection
            .prepare_cached("SELECT max(last_seen_ms) FROM traces")?
            .query_row([], |row| row.get(0))?;
        Ok(IngestClock {
            last_ms: log.into_iter().chain(trace).max().unwrap_or(i64::MIN),
        })
    }

    /// The stamp for the next export, given the wall clock's reading `wall_ms`: later than every
    /// stamp this clock has given.
    pub fn stamp(&mut self, wall_ms: i64) -> i64 {
        self.last_ms = wall_ms.max(self.last_ms.saturating_add(1));
        self.last_ms
    }

    /// The time now, which retention ages rows by: the wall clock, never earlier than the latest
    /// stamp.
    pub fn now(&self, wall_ms: i64) -> i64 {
        wall_ms.max(self.last_ms)
    }
}

pub fn now_ms() -> i64 {
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
    store_spans_at(connection, export, now_ms())
}

/// `store_spans`, stamping with `now` (the writer's `IngestClock`).
pub fn store_spans_at(
    connection: &mut Connection,
    export: &Spans,
    now: i64,
) -> rusqlite::Result<usize> {
    let transaction = connection.transaction()?;
    // Traces this export touched, by id, in the order first seen; `None` for a trace not stored.
    let mut traces: HashMap<[u8; 16], Option<Summary>> = HashMap::new();
    let mut counted = 0;
    // A span of the trace being evicted is counted and not written; see `retention`.
    let evicting = crate::retention::evicting(&transaction)?;
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
            if summary_id.is_some() && summary_id == evicting {
                continue;
            }
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
                            "INSERT INTO traces (trace_id, service_name, started_ns, ended_ns, first_seen_ms, last_seen_ms, span_count, error_count, running_count)
                             VALUES (?1, '', 0, 0, ?2, ?2, 0, 0, 0) RETURNING id",
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
    store_logs_at(connection, export, now_ms())
}

/// `store_logs`, stamping with `now` (the writer's `IngestClock`).
pub fn store_logs_at(
    connection: &mut Connection,
    export: &Logs,
    now: i64,
) -> rusqlite::Result<usize> {
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
