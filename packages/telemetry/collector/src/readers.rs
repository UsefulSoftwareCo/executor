//! The store's readers: a fixed number of read-only connections that answer queries.
//!
//! - A query first waits at the read gate while the writer has it closed (`store::ReadGate`), at
//!   most `GATE_WAIT`, then takes one of `READERS` permits before any blocking work starts. With
//!   the gate still closed, or no permit free within `PERMIT_WAIT`, it is answered 503 with
//!   `Retry-After: 1`.
//! - A permit is held until the query has given its connection back and its response body has
//!   left the collector, sent or dropped (`Streamed`), whichever is later: at most `READERS`
//!   responses are in memory at once, however slowly their callers read.
//! - Each query is one read transaction on its own blocking thread, and its response must be sent
//!   by `QUERY_DEADLINE` after it took its permit. SQLite's progress handler checks the deadline
//!   every `PROGRESS_STEPS` virtual-machine steps and interrupts the statement past it; the
//!   query's own loops (`text`, a trace's tree) check it with `Out::check`; a body not yet sent
//!   is ended by the connection (`connection::ResponseDeadline`), which drops what was queued.
//!   So no reader holds a snapshot of the write-ahead log, and no response lives, longer than that.
//! - While the gate is closed, running reads finish within their deadline unless the writer finds
//!   the log so far along that waiting would refuse exports; then they give way (`Stop::Yielded`).
//! - Results are written to the response as they are read, in chunks of exactly `CHUNK_BYTES`,
//!   cut inside a value when it is larger, through a queue of `BODY_CHUNKS` chunks (`body`). What a query
//!   itself keeps is in `query.rs`.
//! - A caller that hangs up cancels its query: before the response starts, by dropping the
//!   request, which interrupts SQLite and sets the flag `Out::check` reads; after, because the
//!   body can no longer be sent.
//! - When the collector stops, `stop` refuses new queries; the process exits within its stop
//!   budget whatever the running ones are doing.
//! - When a response ends, the writer is asked to return freed memory (`store::MemoryRelease`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use crate::body::CutOff;
use crate::body::{BodyReader, BodySender};
use axum::body::{Body, Bytes};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http_body::Frame;
use rusqlite::{Connection, InterruptHandle, OpenFlags};
use serde_json::json;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};

use crate::connection::ResponseDeadline;
use crate::store::{MemoryRelease, ReadGate};

/// Read-only connections, and so queries running at once.
pub const READERS: usize = 4;

/// Each reader connection's page cache: SQLite's default, set so it is a bound the collector
/// names. Sorting for a query spills to a temporary file past it.
pub const READER_CACHE_BYTES: usize = 2000 * 1024;
/// How long a query waits at the read gate, closed while the writer empties the write-ahead log,
/// before it is refused with 503 and `Retry-After: 1`.
pub const GATE_WAIT: Duration = Duration::from_secs(2);
/// How long a query waits for a free reader before it is refused.
pub const PERMIT_WAIT: Duration = Duration::from_secs(1);
/// The longest one query may run, from taking its reader to the last byte of its response.
pub const QUERY_DEADLINE: Duration = Duration::from_secs(5);
/// How many SQLite virtual-machine steps run between checks of a query's deadline.
const PROGRESS_STEPS: i32 = 1_000;
/// A response's body is sent in chunks of this size; the last may be smaller.
pub const CHUNK_BYTES: usize = 64 * 1024;
/// How long one wait for a slow caller lasts before the deadline and the gate are checked again.
const SEND_SLICE: Duration = Duration::from_millis(50);
/// Chunks waiting to be sent, per response.
pub const BODY_CHUNKS: usize = 4;

/// Why a query ended without finishing its response.
#[derive(Debug)]
pub enum Stop {
    /// It reached its deadline.
    Deadline,
    /// The caller hung up, or the collector is stopping.
    Gone,
    /// It gave its reader back so the writer could empty the write-ahead log before refusing
    /// exports (`Preempt`).
    Yielded,
    /// The store was busy or locked past the connection's busy timeout, or in SQLite's retry of
    /// its locking protocol: unavailable for a moment, not a fault.
    Busy,
    /// SQLite failed.
    Failed(String),
}

/// When a running read must give way: the writer has found the write-ahead log past the share
/// of its bound where waiting longer for reads would lead to refusing exports
/// (`store::ReadGate::preempting`).
struct Preempt {
    gate: Arc<ReadGate>,
}

impl Preempt {
    fn due(&self) -> bool {
        self.gate.preempting()
    }
}

impl From<rusqlite::Error> for Stop {
    fn from(error: rusqlite::Error) -> Self {
        match error.sqlite_error_code() {
            Some(rusqlite::ErrorCode::OperationInterrupted) => Stop::Deadline,
            Some(
                rusqlite::ErrorCode::DatabaseBusy
                | rusqlite::ErrorCode::DatabaseLocked
                | rusqlite::ErrorCode::FileLockingProtocolFailed,
            ) => Stop::Busy,
            _ => Stop::Failed(error.to_string()),
        }
    }
}

type Head = (StatusCode, Streamed);

/// A response's body as the HTTP side sends it: the chunks the query writes, and the query's
/// reader permit, held until the body has been sent or dropped. So at most `READERS` responses
/// are in memory at once, however slowly their callers read; the connection's deadline
/// (`connection::ResponseDeadline`) ends one that is not sent by the query's deadline.
pub struct Streamed {
    channel: BodyReader,
    _permit: Arc<OwnedSemaphorePermit>,
    /// Told when the body ends, so the permit goes once the server has flushed what it holds.
    connection: ResponseDeadline,
    release: Arc<MemoryRelease>,
    /// Counts the body as cut off when it is dropped unfinished past the deadline, whichever side
    /// noticed the deadline first: the query, or the connection (`connection::ResponseDeadline`).
    cut_off: Arc<AtomicU64>,
    deadline: Instant,
    ended: bool,
}

impl http_body::Body for Streamed {
    type Data = Bytes;
    type Error = CutOff;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<Frame<Bytes>, CutOff>>> {
        let frame = std::pin::Pin::new(&mut self.channel).poll_frame(context);
        if let std::task::Poll::Ready(None) = frame {
            self.ended = true;
        }
        frame
    }

    fn is_end_stream(&self) -> bool {
        self.channel.is_end_stream()
    }
}

impl Drop for Streamed {
    fn drop(&mut self) {
        // Counted once: here when the body was dropped unfinished past its deadline (the query
        // gave up on it), and then not again by the connection when its own deadline passes
        // with the server's buffer unflushed; counting both made five cut-offs of four.
        let cut_off = !self.ended && Instant::now() >= self.deadline;
        if cut_off {
            self.cut_off.fetch_add(1, Ordering::SeqCst);
        }
        self.connection.body_ended(cut_off);
        // What the answer allocated is free now; return it to the system once idle, as exports do.
        self.release.request();
    }
}

/// Where a query writes its response: first its status, then its JSON body in chunks of
/// `CHUNK_BYTES`, cut inside a value when it is larger.
pub struct Out {
    sink: Sink,
    buffer: Vec<u8>,
    deadline: Instant,
    preempt: Option<Arc<Preempt>>,
    /// Set when the caller hung up before the response started, or the collector is stopping.
    /// SQLite is interrupted as well; this stops the query's own loops (`text`, trees).
    cancelled: Option<Arc<AtomicBool>>,
    /// Why a write failed, for the writer that serializes into the body.
    stopped: Option<Stop>,
}

/// Where a query's response goes.
enum Sink {
    /// An HTTP response: its head to the waiting handler, then its body through a channel.
    Response {
        head: Option<oneshot::Sender<Head>>,
        body: Option<BodySender>,
        runtime: tokio::runtime::Handle,
        /// The reader permit, until the body takes it.
        permit: Option<Arc<OwnedSemaphorePermit>>,
        release: Arc<MemoryRelease>,
        cut_off: Arc<AtomicU64>,
        connection: ResponseDeadline,
    },
    /// Kept in memory, for `collect`; or only counted, when `keep` is false.
    Collected {
        status: Option<StatusCode>,
        bytes: Vec<u8>,
        keep: bool,
        counted: usize,
    },
}

impl Out {
    /// Start the response with `status`. Called once, before any body.
    pub fn start(&mut self, status: StatusCode) -> Result<(), Stop> {
        match &mut self.sink {
            Sink::Response {
                head,
                body,
                permit,
                release,
                cut_off,
                connection,
                ..
            } => {
                let (sender, channel) = crate::body::body(BODY_CHUNKS);
                let head = head
                    .take()
                    .ok_or(Stop::Failed("started twice".to_owned()))?;
                let permit = permit
                    .take()
                    .ok_or(Stop::Failed("no reader permit".to_owned()))?;
                // Before the head is sent: the connection holds the permit from here until what
                // the server buffers has been flushed.
                connection.start(self.deadline, permit.clone(), cut_off.clone());
                let streamed = Streamed {
                    channel,
                    _permit: permit,
                    connection: connection.clone(),
                    release: release.clone(),
                    cut_off: cut_off.clone(),
                    deadline: self.deadline,
                    ended: false,
                };
                head.send((status, streamed)).map_err(|_| Stop::Gone)?;
                *body = Some(sender);
            }
            Sink::Collected {
                status: started, ..
            } => *started = Some(status),
        }
        Ok(())
    }

    pub fn text(&mut self, text: &str) -> Result<(), Stop> {
        self.write_body(text.as_bytes())
    }

    pub fn json(&mut self, value: &(impl serde::Serialize + ?Sized)) -> Result<(), Stop> {
        let result = serde_json::to_writer(&mut *self, value);
        match (result, self.stopped.take()) {
            (Ok(()), _) => Ok(()),
            (Err(_), Some(stop)) => Err(stop),
            (Err(error), None) => Err(Stop::Failed(error.to_string())),
        }
    }

    /// Add `bytes` to the body, sending each `CHUNK_BYTES` as it fills.
    fn write_body(&mut self, mut bytes: &[u8]) -> Result<(), Stop> {
        while !bytes.is_empty() {
            if self.buffer.capacity() < CHUNK_BYTES {
                // Exactly one chunk, so it never grows past it by doubling.
                self.buffer.reserve_exact(CHUNK_BYTES - self.buffer.len());
            }
            let room = CHUNK_BYTES.saturating_sub(self.buffer.len()).max(1);
            let (now, later) = bytes.split_at(room.min(bytes.len()));
            self.buffer.extend_from_slice(now);
            bytes = later;
            if self.buffer.len() >= CHUNK_BYTES {
                self.flush()?;
            }
        }
        Ok(())
    }

    /// Whether the deadline has passed, or the read must give way.
    pub fn check(&self) -> Result<(), Stop> {
        if Instant::now() >= self.deadline {
            return Err(Stop::Deadline);
        }
        if self
            .cancelled
            .as_ref()
            .is_some_and(|cancelled| cancelled.load(Ordering::SeqCst))
        {
            return Err(Stop::Gone);
        }
        if self.preempt.as_ref().is_some_and(|preempt| preempt.due()) {
            return Err(Stop::Yielded);
        }
        Ok(())
    }

    /// Send what is buffered, waiting at most until the deadline for the caller to take it.
    pub fn flush(&mut self) -> Result<(), Stop> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        // The next chunk's buffer is made when the first byte is written to it, after this one
        // has been sent: a send that waits holds the chunks queued and this one, not a sixth.
        let chunk = std::mem::take(&mut self.buffer);
        match &mut self.sink {
            Sink::Response { body, runtime, .. } => {
                let body = body
                    .as_mut()
                    .ok_or(Stop::Failed("not started".to_owned()))?;
                // Wait for the caller in short slices, so a slow caller gives way to the deadline
                // or the writer as a query does. A send cut short sends nothing, so the chunk is
                // sent again.
                let chunk = Bytes::from(chunk);
                loop {
                    let deadline = self.deadline;
                    let preempt = self.preempt.clone();
                    if Instant::now() >= deadline {
                        return Err(Stop::Deadline);
                    }
                    if preempt.is_some_and(|preempt| preempt.due()) {
                        return Err(Stop::Yielded);
                    }
                    let slice = deadline
                        .saturating_duration_since(Instant::now())
                        .min(SEND_SLICE);
                    match runtime.block_on(tokio::time::timeout(slice, body.send(chunk.clone()))) {
                        Ok(Ok(())) => return Ok(()),
                        Ok(Err(_)) => return Err(Stop::Gone),
                        Err(_) => continue,
                    }
                }
            }
            Sink::Collected {
                bytes,
                keep,
                counted,
                ..
            } => {
                *counted += chunk.len();
                if *keep {
                    bytes.extend_from_slice(&chunk);
                }
                Ok(())
            }
        }
    }

    /// End the body: flush it, or cut it off when the query stopped part way.
    fn finish(mut self, result: Result<(), Stop>) -> Result<(), Stop> {
        let result = result.and_then(|()| self.flush());
        if let Sink::Response { body, .. } = &mut self.sink
            && let Some(body) = body.take()
        {
            // Whole: dropped, it ends the body after its chunks. Otherwise cut off.
            if result.is_err() {
                body.abort();
            }
        }
        result
    }

    /// Whether the response has started.
    fn started(&self) -> bool {
        match &self.sink {
            Sink::Response { head, .. } => head.is_none(),
            Sink::Collected { status, .. } => status.is_some(),
        }
    }
}

/// The body as a writer, for `serde_json`; a write that cannot be sent keeps its reason.
impl std::io::Write for Out {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        match self.write_body(bytes) {
            Ok(()) => Ok(bytes.len()),
            Err(stop) => {
                self.stopped = Some(stop);
                Err(std::io::Error::other("the response stopped"))
            }
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for Out {
    fn drop(&mut self) {
        if let Sink::Response { release, body, .. } = &mut self.sink {
            // Still holding the body here means `finish` never ran: the query unwound after its
            // head was sent. Cut the body off, so the caller sees the transfer end early, not a
            // whole answer (the sender's own drop would end it as complete).
            if let Some(body) = body.take() {
                body.abort();
            }
            release.request();
        }
    }
}

/// Run `query` in a read transaction on `connection` and keep its whole response in memory: the
/// status and body. For tests and measurements; the HTTP routes stream through `Readers::answer`.
pub fn collect<F>(connection: &mut Connection, query: F) -> Result<(StatusCode, Vec<u8>), Stop>
where
    F: FnOnce(&Connection, &mut Out) -> Result<(), Stop>,
{
    collect_within(connection, QUERY_DEADLINE, query)
}

/// `collect`, with a deadline of `budget` from now instead of `QUERY_DEADLINE`.
pub fn collect_within<F>(
    connection: &mut Connection,
    budget: Duration,
    query: F,
) -> Result<(StatusCode, Vec<u8>), Stop>
where
    F: FnOnce(&Connection, &mut Out) -> Result<(), Stop>,
{
    run_collected(connection, budget, true, query).map(|(status, bytes, _)| (status, bytes))
}

/// The answer's status and length, its bytes counted and dropped as they are written, for the
/// tests that measure what answering holds.
pub fn answer_length<F>(connection: &mut Connection, query: F) -> Result<(StatusCode, usize), Stop>
where
    F: FnOnce(&Connection, &mut Out) -> Result<(), Stop>,
{
    run_collected(connection, Duration::from_secs(300), false, query)
        .map(|(status, _, counted)| (status, counted))
}
fn run_collected<F>(
    connection: &mut Connection,
    budget: Duration,
    keep: bool,
    query: F,
) -> Result<(StatusCode, Vec<u8>, usize), Stop>
where
    F: FnOnce(&Connection, &mut Out) -> Result<(), Stop>,
{
    let deadline = Instant::now() + budget;
    let mut out = Out {
        sink: Sink::Collected {
            status: None,
            bytes: Vec::new(),
            keep,
            counted: 0,
        },
        buffer: Vec::new(),
        deadline,
        preempt: None,
        cancelled: None,
        stopped: None,
    };
    let result = read(connection, deadline, None, None, |connection| {
        query(connection, &mut out)
    });
    out.finish_collected(result)
}

impl Out {
    fn finish_collected(
        mut self,
        result: Result<(), Stop>,
    ) -> Result<(StatusCode, Vec<u8>, usize), Stop> {
        result?;
        self.flush()?;
        debug_assert!(self.started());
        match &mut self.sink {
            Sink::Collected {
                status: Some(status),
                bytes,
                counted,
                ..
            } => Ok((*status, std::mem::take(bytes), *counted)),
            _ => Err(Stop::Failed("the query answered nothing".to_owned())),
        }
    }
}

/// The pool, shared by every query.
pub struct Readers {
    connections: Mutex<Vec<Connection>>,
    permits: Arc<Semaphore>,
    /// Interrupt handles of the queries running now. Every interrupt goes through this map, under
    /// its lock, and a query leaves it before its connection goes back to the pool, so an
    /// interrupt never reaches a later query on the same connection.
    running: Mutex<HashMap<u64, (InterruptHandle, Arc<AtomicBool>)>>,
    next: AtomicU64,
    stopping: AtomicBool,
    /// Queries refused because no reader was free within `PERMIT_WAIT`.
    refused_busy: AtomicU64,
    /// Queries refused because the read gate stayed closed for `GATE_WAIT`.
    refused_gate: AtomicU64,
    gate: Arc<ReadGate>,
    release: Arc<MemoryRelease>,
    /// Queries and responses cut off at their deadline.
    cut_off: Arc<AtomicU64>,
    /// Queries that gave way to the writer (`Preempt`).
    yielded: AtomicU64,
    /// Queries answered 503 because the store was busy or locked (`Stop::Busy`).
    refused_store_busy: AtomicU64,
}

impl Readers {
    /// Open `READERS` read-only connections to the store. Called after the writer has opened or
    /// created it.
    pub fn open(
        database: &Path,
        gate: Arc<ReadGate>,
        release: Arc<MemoryRelease>,
    ) -> Result<Arc<Readers>, String> {
        let mut connections = Vec::with_capacity(READERS);
        for _ in 0..READERS {
            let connection = Connection::open_with_flags(
                database,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )
            .map_err(|error| error.to_string())?;
            connection
                .busy_timeout(crate::store::BUSY_TIMEOUT)
                .map_err(|error| error.to_string())?;
            connection
                .pragma_update(None, "cache_size", -((READER_CACHE_BYTES / 1024) as i64))
                .map_err(|error| error.to_string())?;
            connections.push(connection);
        }
        Ok(Arc::new(Readers {
            connections: Mutex::new(connections),
            permits: Arc::new(Semaphore::new(READERS)),
            running: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            stopping: AtomicBool::new(false),
            refused_busy: AtomicU64::new(0),
            refused_gate: AtomicU64::new(0),
            gate,
            release,
            cut_off: Arc::new(AtomicU64::new(0)),
            yielded: AtomicU64::new(0),
            refused_store_busy: AtomicU64::new(0),
        }))
    }

    /// `/api/ingest`'s `readers`: how many there are, how many are answering now, and how many
    /// queries were refused for want of one or cut off at their deadline.
    pub fn figures(&self) -> serde_json::Value {
        json!({
            "max": READERS,
            "busy": READERS - self.permits.available_permits().min(READERS),
            "refusedBusy": self.refused_busy.load(Ordering::SeqCst),
            "refusedGate": self.refused_gate.load(Ordering::SeqCst),
            "cutOff": self.cut_off.load(Ordering::SeqCst),
            "yielded": self.yielded.load(Ordering::SeqCst),
            "storeBusy": self.refused_store_busy.load(Ordering::SeqCst),
        })
    }

    /// Refuse new queries. Queries still running are not interrupted: the process exits at the
    /// end of its stop budget whatever its blocking threads are doing (`main`), so none can hold
    /// the stop up.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.permits.close();
    }

    fn interrupt(&self, id: u64) {
        if let Some((handle, cancelled)) = lock(&self.running).get(&id) {
            cancelled.store(true, Ordering::SeqCst);
            handle.interrupt();
        }
    }

    /// Run `query` in a read transaction on a reader and answer with what it writes. The
    /// response must be sent by the query's deadline: `connection` is the deadline of the HTTP
    /// connection it is sent on.
    pub async fn answer<F>(self: &Arc<Self>, connection: &ResponseDeadline, query: F) -> Response
    where
        F: FnOnce(&Connection, &mut Out) -> Result<(), Stop> + Send + 'static,
    {
        if self.stopping.load(Ordering::SeqCst) {
            return unavailable("The collector is stopping", None);
        }
        // Before any reader is taken: a query held at the gate holds nothing.
        if !self.gate.wait_open(GATE_WAIT).await {
            self.refused_gate.fetch_add(1, Ordering::SeqCst);
            return unavailable(
                "The store is emptying its write-ahead log; retry shortly",
                Some("1"),
            );
        }
        let permit =
            match tokio::time::timeout(PERMIT_WAIT, self.permits.clone().acquire_owned()).await {
                Ok(Ok(permit)) => permit,
                Ok(Err(_)) => return unavailable("The collector is stopping", None),
                Err(_) => {
                    self.refused_busy.fetch_add(1, Ordering::SeqCst);
                    return unavailable("Every reader is busy; retry shortly", Some("1"));
                }
            };
        // A permit is held by at most one query or one unfinished body, and a connection goes
        // back to the pool before its permit does, so one is free.
        let Some(database) = lock(&self.connections).pop() else {
            return failed("no reader connection was free with a permit");
        };
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let cancelled = Arc::new(AtomicBool::new(false));
        lock(&self.running).insert(id, (database.get_interrupt_handle(), cancelled.clone()));
        // The permit is free once both the query has given its connection back and the body is
        // done with; whichever is later.
        let permit = Arc::new(permit);
        // Gives the connection back however the query ends, a panic included.
        let mut database = Lease {
            readers: self.clone(),
            id,
            connection: Some(database),
            _permit: permit.clone(),
        };
        let deadline = Instant::now() + QUERY_DEADLINE;
        // Interrupts the query if this request is dropped before its response starts.
        let mut guard = InterruptOnDrop(Some((self.clone(), id)));
        let (head, headed) = oneshot::channel();
        let readers = self.clone();
        let runtime = tokio::runtime::Handle::current();
        let connection = connection.clone();
        let task = tokio::task::spawn_blocking(move || {
            let preempt = Arc::new(Preempt {
                gate: readers.gate.clone(),
            });
            let mut out = Out {
                sink: Sink::Response {
                    head: Some(head),
                    body: None,
                    runtime,
                    permit: Some(permit),
                    release: readers.release.clone(),
                    cut_off: readers.cut_off.clone(),
                    connection: connection.clone(),
                },
                buffer: Vec::new(),
                deadline,
                preempt: Some(preempt.clone()),
                cancelled: Some(cancelled.clone()),
                stopped: None,
            };
            let Some(connection) = database.connection.as_mut() else {
                return Err(Stop::Failed("the lease has no connection".to_owned()));
            };
            let result = read(
                connection,
                deadline,
                Some(preempt),
                Some(cancelled),
                |connection| query(connection, &mut out),
            );
            let started = out.started();
            let result = out.finish(result);
            match result {
                // After the response started, its body counts it when dropped.
                Err(Stop::Deadline) if !started => {
                    readers.cut_off.fetch_add(1, Ordering::SeqCst);
                }
                Err(Stop::Yielded) => {
                    readers.yielded.fetch_add(1, Ordering::SeqCst);
                }
                _ => {}
            }
            drop(database);
            result
        });
        let response = match headed.await {
            Ok((status, body)) => {
                let mut response = Response::new(Body::new(body));
                *response.status_mut() = status;
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                );
                response
            }
            // The query ended without starting a response.
            Err(_) => match task.await {
                Ok(Err(Stop::Deadline)) => unavailable(
                    &format!(
                        "The query did not finish within {} s",
                        QUERY_DEADLINE.as_secs()
                    ),
                    None,
                ),
                Ok(Err(Stop::Gone)) => unavailable("The collector is stopping", None),
                Ok(Err(Stop::Yielded)) => unavailable(
                    "The query gave way while the store emptied its write-ahead log; retry shortly",
                    Some("1"),
                ),
                Ok(Err(Stop::Busy)) => {
                    self.refused_store_busy.fetch_add(1, Ordering::SeqCst);
                    unavailable("The store is busy; retry shortly", Some("1"))
                }
                Ok(Err(Stop::Failed(error))) => failed(&error),
                Ok(Ok(())) => failed("the query answered nothing"),
                Err(error) => failed(&error.to_string()),
            },
        };
        guard.0 = None;
        response
    }
}

/// A reader connection lent to one query. Dropped, on any path, it leaves the running map and
/// goes back to the pool, its transaction ended, so an interrupt never reaches a later query.
struct Lease {
    readers: Arc<Readers>,
    id: u64,
    connection: Option<Connection>,
    /// Dropped after the connection is back in the pool.
    _permit: Arc<OwnedSemaphorePermit>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        lock(&self.readers.running).remove(&self.id);
        if let Some(mut connection) = self.connection.take() {
            let _ = connection.progress_handler(0, None::<fn() -> bool>);
            if !connection.is_autocommit() {
                let _ = connection.execute_batch("ROLLBACK");
            }
            lock(&self.readers.connections).push(connection);
        }
    }
}

/// Interrupts a query when dropped while armed.
struct InterruptOnDrop(Option<(Arc<Readers>, u64)>);

impl Drop for InterruptOnDrop {
    fn drop(&mut self) {
        if let Some((readers, id)) = self.0.take() {
            readers.interrupt(id);
        }
    }
}

/// Run `query` in one read transaction, so it sees one snapshot of the store, with SQLite
/// interrupted past `deadline`, when the read must give way (`preempt`), or when the caller has
/// gone or the collector is stopping (`cancelled`, set before the interrupt handle is used).
///
/// SQLite reports every interrupt the same way, so the reason is noted as it happens and decides
/// what the interrupt was: giving way, then the caller or the stop, then the deadline. Noted, not
/// read again afterwards, because the writer may have emptied the log, and stopped asking, by the
/// time the statement returns.
fn read(
    connection: &mut Connection,
    deadline: Instant,
    preempt: Option<Arc<Preempt>>,
    cancelled: Option<Arc<AtomicBool>>,
    query: impl FnOnce(&Connection) -> Result<(), Stop>,
) -> Result<(), Stop> {
    let preempted = Arc::new(AtomicBool::new(false));
    let noted = preempted.clone();
    let gone = cancelled.clone();
    connection.progress_handler(
        PROGRESS_STEPS,
        Some(move || {
            if gone
                .as_ref()
                .is_some_and(|gone| gone.load(Ordering::SeqCst))
            {
                return true;
            }
            if preempt.as_ref().is_some_and(|preempt| preempt.due()) {
                noted.store(true, Ordering::SeqCst);
                return true;
            }
            Instant::now() >= deadline
        }),
    )?;
    let result = connection
        .execute_batch("BEGIN")
        .map_err(Stop::from)
        .and_then(|()| query(connection));
    // A read transaction has nothing to keep; ending it releases its snapshot. The handler goes
    // first, so a query past its deadline can still end its transaction.
    let _ = connection.progress_handler(0, None::<fn() -> bool>);
    let _ = connection.execute_batch("ROLLBACK");
    match result {
        Err(Stop::Deadline) if preempted.load(Ordering::SeqCst) => Err(Stop::Yielded),
        Err(Stop::Deadline)
            if cancelled
                .as_ref()
                .is_some_and(|cancelled| cancelled.load(Ordering::SeqCst)) =>
        {
            Err(Stop::Gone)
        }
        other => other,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 503: no reader now. `Retry-After` when one will be free soon.
fn unavailable(message: &str, retry_after: Option<&'static str>) -> Response {
    let mut response = (
        StatusCode::SERVICE_UNAVAILABLE,
        axum::Json(json!({ "error": message })),
    )
        .into_response();
    if let Some(seconds) = retry_after {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static(seconds));
    }
    response
}

fn failed(error: &str) -> Response {
    crate::log::error("a query failed", &[("error", error.into())]);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(json!({ "error": error })),
    )
        .into_response()
}
