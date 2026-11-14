//! The built `executor-collector` binary as a process: stopping, its socket, acknowledging only
//! stored exports, creating its store when interrupted, deep nesting at the size limit and with
//! a small stack in the environment, and returning memory after a burst.
#![cfg(unix)]

mod support;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde_json::Value;

const BINARY: &str = env!("CARGO_BIN_EXE_executor-collector");

/// A directory removed when the test ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = support::directory("process", name);
        Scratch(path)
    }

    fn data(&self) -> PathBuf {
        self.0.join("data")
    }

    fn database(&self) -> PathBuf {
        self.data().join("telemetry.sqlite")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone)]
enum Address {
    Tcp(u16),
    Unix(PathBuf),
}

/// How long a start may take to print its listening line or fail.
const START_LIMIT: Duration = Duration::from_secs(20);
/// How long a stopped or failing collector may take to exit, unless a test sets its own bound.
const EXIT_LIMIT: Duration = Duration::from_secs(10);
/// How long one HTTP exchange may take.
const IO_LIMIT: Duration = Duration::from_secs(30);

/// A child process that is killed and reaped when dropped, so a failing test never leaves it
/// running. Every spawn is wrapped in it at once.
struct Owned(Child);

impl Owned {
    /// Wait for the process to exit, for at most `limit`. Past that, kill and reap it and fail.
    fn wait_within(&mut self, limit: Duration) -> ExitStatus {
        let started = Instant::now();
        loop {
            if let Some(status) = self.0.try_wait().expect("try_wait") {
                return status;
            }
            if started.elapsed() >= limit {
                let _ = self.0.kill();
                let _ = self.0.wait();
                panic!("the collector had not exited {limit:?} after it was expected to");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Everything the process wrote on stderr. Call after it has exited.
    fn stderr(&mut self) -> String {
        let mut stderr = String::new();
        if let Some(mut pipe) = self.0.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        stderr
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A running collector.
struct Collector {
    process: Owned,
    address: Address,
}

impl Collector {
    /// Start the binary and wait for its listening line.
    fn start(data: &Path, extra: &[&str]) -> Collector {
        Collector::try_start(data, extra).unwrap_or_else(|(status, stderr)| {
            panic!("the collector did not start ({status:?}): {stderr}")
        })
    }

    /// Start the binary. Without a listening line, the exit status and stderr.
    fn try_start(data: &Path, extra: &[&str]) -> Result<Collector, (ExitStatus, String)> {
        let mut command = Command::new(BINARY);
        command.arg("serve").arg("--data").arg(data);
        if !extra.contains(&"--listen") {
            command.args(["--listen", "127.0.0.1:0"]);
        }
        Collector::spawn(command.args(extra))
    }

    fn spawn(command: &mut Command) -> Result<Collector, (ExitStatus, String)> {
        let mut process = Owned(
            command
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn the collector"),
        );
        let stdout = process.0.stdout.take().expect("stdout");
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = sender.send(line);
        });
        let line = receiver
            .recv_timeout(START_LIMIT)
            .unwrap_or_else(|_| panic!("no listening line within {START_LIMIT:?}"));
        if line.is_empty() {
            let status = process.wait_within(EXIT_LIMIT);
            return Err((status, process.stderr()));
        }
        let ready: Value = serde_json::from_str(&line).expect("the listening line is JSON");
        assert_eq!(ready["event"], "listening");
        let address = match (ready["port"].as_u64(), ready["path"].as_str()) {
            (Some(port), _) => Address::Tcp(port as u16),
            (_, Some(path)) => Address::Unix(PathBuf::from(path)),
            _ => panic!("unexpected listening line {line}"),
        };
        Ok(Collector { process, address })
    }

    fn pid(&self) -> u32 {
        self.process.0.id()
    }

    fn post(&self, path: &str, body: &[u8]) -> (u16, Value) {
        request(&self.address, "POST", path, Some(body))
    }

    fn get(&self, path: &str) -> (u16, Value) {
        request(&self.address, "GET", path, None)
    }

    /// Send SIGTERM and wait, for at most `limit`, for the process to exit. The exit status,
    /// stderr and how long it took. A process still running at `limit` is killed and the test
    /// fails.
    fn stop_within(mut self, limit: Duration) -> (ExitStatus, String, Duration) {
        let started = Instant::now();
        terminate_now(self.pid());
        let status = self.process.wait_within(limit);
        let took = started.elapsed();
        (status, self.process.stderr(), took)
    }

    fn stop(self) -> (ExitStatus, String, Duration) {
        self.stop_within(EXIT_LIMIT)
    }
}

unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

/// SIGTERM, sent with `kill(2)` itself: running `/bin/kill` takes long enough to hide a race.
fn terminate_now(pid: u32) {
    const SIGTERM: i32 = 15;
    // SAFETY: kill takes no pointers; the pid is our own child's, which we have not waited on.
    let sent = unsafe { kill(pid as i32, SIGTERM) };
    assert_eq!(sent, 0, "kill({pid}, SIGTERM) failed");
}

/// Taken by the tests that move hundreds of megabytes or read very large answers, so they do not
/// run at once: each measures time or resident memory that the others would disturb.
fn heavy() -> std::sync::MutexGuard<'static, ()> {
    static HEAVY: std::sync::Mutex<()> = std::sync::Mutex::new(());
    HEAVY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One HTTP/1.1 request on its own connection; the status and the JSON body.
fn request(address: &Address, method: &str, path: &str, body: Option<&[u8]>) -> (u16, Value) {
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: collector\r\nConnection: close\r\n");
    if let Some(body) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    head.push_str("\r\n");
    let mut raw = head.into_bytes();
    raw.extend_from_slice(body.unwrap_or_default());
    exchange(address, &raw)
}

thread_local! {
    /// The last response this thread received: its head and the start of its body.
    static LAST_RESPONSE: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// On a failing assertion, also print the last response the failing thread received, its
/// status, headers and body: an assertion on a status then shows what the collector answered.
fn show_last_response_on_failure() {
    static HOOK: std::sync::Once = std::sync::Once::new();
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            previous(info);
            let last = LAST_RESPONSE.with(|last| last.borrow().clone());
            if !last.is_empty() {
                eprintln!("the last response this thread received:\n{last}");
            }
        }));
    });
}

/// The last response this thread received, as `LAST_RESPONSE` keeps it.
fn last_response() -> String {
    LAST_RESPONSE.with(|last| last.borrow().clone())
}

fn exchange(address: &Address, raw: &[u8]) -> (u16, Value) {
    show_last_response_on_failure();
    let mut response = Vec::new();
    match address {
        Address::Tcp(port) => {
            let mut stream = TcpStream::connect(("127.0.0.1", *port)).expect("connect");
            stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
            stream.set_write_timeout(Some(IO_LIMIT)).expect("timeout");
            // A refusal can be answered before the body is read; the answer is still there.
            let _ = stream.write_all(raw);
            stream.read_to_end(&mut response).expect("receive");
        }
        Address::Unix(path) => {
            let mut stream = UnixStream::connect(path).expect("connect");
            stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
            stream.set_write_timeout(Some(IO_LIMIT)).expect("timeout");
            // A refusal can be answered before the body is read; the answer is still there.
            let _ = stream.write_all(raw);
            stream.read_to_end(&mut response).expect("receive");
        }
    }
    received(&response)
}

/// A whole response as read: kept as the last one, for a failing assertion to print, and its
/// status and JSON body. A 200 whose body is not JSON fails the test. Every helper that reads a
/// response goes through this.
fn received(response: &[u8]) -> (u16, Value) {
    show_last_response_on_failure();
    LAST_RESPONSE.with(|last| {
        let shown = &response[..response.len().min(8 << 10)];
        *last.borrow_mut() = format!(
            "{}{}",
            String::from_utf8_lossy(shown),
            if shown.len() < response.len() {
                format!("... ({} bytes in all)", response.len())
            } else {
                String::new()
            }
        );
    });
    let (status, headers, body) = split_response(response);
    let body = if headers.contains("transfer-encoding: chunked") {
        dechunk(body).expect("a complete chunked body")
    } else {
        body.to_vec()
    };
    // Every route answers JSON. A 200 that is not, an empty body included, is a lost answer
    // (the round-five race), never something to read as null; other statuses may have no body.
    match serde_json::from_slice(&body) {
        Ok(value) => (status, value),
        Err(error) if status == 200 => panic!(
            "a 200 whose body is not JSON ({error}):\n{}",
            String::from_utf8_lossy(&response[..response.len().min(8 << 10)])
        ),
        Err(_) => (status, Value::Null),
    }
}

/// A response's status, its headers lowercased, and its raw body.
fn split_response(response: &[u8]) -> (u16, String, &[u8]) {
    let end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("a response head");
    let head = String::from_utf8_lossy(&response[..end]).to_ascii_lowercase();
    let status = head[9..12].parse().expect("status code");
    (status, head, &response[end + 4..])
}

/// A chunked body's bytes; `None` when it ends before its last, empty chunk.
fn dechunk(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut decoded = Vec::new();
    loop {
        let line = body.windows(2).position(|window| window == b"\r\n")?;
        let size =
            usize::from_str_radix(std::str::from_utf8(&body[..line]).ok()?.trim(), 16).ok()?;
        body = &body[line + 2..];
        if size == 0 {
            return Some(decoded);
        }
        decoded.extend_from_slice(body.get(..size)?);
        body = body.get(size + 2..)?;
    }
}

/// Distinct hex ids from a counter, so every span and trace is new.
struct Ids(u64);

impl Ids {
    /// The next id of `bytes` bytes as hex. Multiplying by an odd constant is a bijection modulo
    /// any power of two, so ids never repeat.
    fn next(&mut self, bytes: usize) -> String {
        self.0 += 1;
        let mixed = u128::from(self.0).wrapping_mul(0x9e37_79b9_7f4a_7c15_f39c_c060_5ced_c835);
        let bits = bytes * 8;
        let value = if bits >= 128 {
            mixed
        } else {
            mixed & ((1u128 << bits) - 1)
        };
        format!("{value:0width$x}", width = bytes * 2)
    }
}

/// A traces export shaped like the memory scenario's: `count` spans in traces of 30, each with a
/// 300-character query attribute. With `bad_last_span`, the last span's id is invalid, so the
/// whole export is decoded and then refused.
fn burst_export(ids: &mut Ids, count: usize, bad_last_span: bool) -> Vec<u8> {
    let mut spans = Vec::with_capacity(count);
    let start: u64 = 1_700_000_000_000_000_000;
    let mut trace = String::new();
    let mut root = String::new();
    for index in 0..count {
        let step = index % 30;
        if step == 0 {
            trace = ids.next(16);
            root = ids.next(8);
        }
        let span_id = if bad_last_span && index == count - 1 {
            "not-a-span-id".to_owned()
        } else if step == 0 {
            root.clone()
        } else {
            ids.next(8)
        };
        let parent = if step == 0 {
            String::new()
        } else {
            root.clone()
        };
        let comment = (0..10).map(|_| ids.next(15)).collect::<String>();
        spans.push(format!(
            r#"{{"traceId":"{trace}","spanId":"{span_id}","parentSpanId":"{parent}","name":"sql.execute","kind":1,"startTimeUnixNano":"{}","endTimeUnixNano":"{}","attributes":[{{"key":"db.query.text","value":{{"stringValue":"SELECT * FROM notes WHERE id = ? -- {comment}"}}}},{{"key":"app.step","value":{{"intValue":"{step}"}}}}]}}"#,
            start + step as u64 * 1000,
            start + step as u64 * 1000 + 500
        ));
    }
    format!(
        r#"{{"resourceSpans":[{{"resource":{{"attributes":[{{"key":"service.name","value":{{"stringValue":"burst"}}}}]}},"scopeSpans":[{{"scope":{{"name":"burst"}},"spans":[{}]}}]}}]}}"#,
        spans.join(",")
    )
    .into_bytes()
}

fn small_export(trace: &str, span: &str) -> Vec<u8> {
    format!(
        r#"{{"resourceSpans":[{{"resource":{{"attributes":[{{"key":"service.name","value":{{"stringValue":"svc"}}}}]}},"scopeSpans":[{{"spans":[{{"traceId":"{trace}","spanId":"{span}","name":"op","startTimeUnixNano":"1","endTimeUnixNano":"2"}}]}}]}}]}}"#
    )
    .into_bytes()
}

fn count(connection: &Connection, sql: &str) -> i64 {
    connection
        .query_row(sql, [], |row| row.get(0))
        .expect("query")
}

#[test]
fn a_stop_signal_sent_as_soon_as_it_is_listening_stops_it_cleanly() {
    let scratch = Scratch::new("signal");
    // Before the fix about a third of starts missed the signal handler, though only when the
    // signal won a narrow race. Each start takes milliseconds, so 200 catch it reliably.
    for attempt in 0..200 {
        let collector = Collector::start(&scratch.data(), &[]);
        let (status, stderr, _) = collector.stop();
        assert!(
            status.success() && stderr.contains("collector stopped"),
            "attempt {attempt}: {status:?} {stderr}"
        );
    }
}

/// A request that never finishes is already open when the stop signal arrives, right after the
/// listening line. The drain gives it 1.5 s and the collector exits within its budget. A stop
/// that reached the drain before the drain was waiting for it used to be lost, and the collector
/// then waited for the request until its sender gave up.
#[test]
fn a_stop_right_after_readiness_with_an_unfinished_request_ends_within_the_budget() {
    let scratch = Scratch::new("unfinished");
    for attempt in 0..3 {
        let collector = Collector::start(&scratch.data(), &[]);
        let Address::Tcp(port) = collector.address else {
            unreachable!()
        };
        let mut unfinished = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        unfinished
            .write_all(b"POST /v1/traces HTTP/1.1\r\nHost: collector\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{")
            .expect("send part of a request");
        let (status, stderr, took) = collector.stop_within(Duration::from_secs(4));
        assert!(
            took < Duration::from_millis(3_000),
            "attempt {attempt}: stopping took {took:?}: {stderr}"
        );
        assert!(status.success(), "attempt {attempt}: {status:?} {stderr}");
        drop(unfinished);
    }
}

#[test]
fn a_socket_path_that_exists_is_refused_and_only_the_collectors_own_socket_is_removed() {
    let scratch = Scratch::new("socket");
    let socket = scratch.0.join("collector.sock");
    let listen = format!("unix:{}", socket.display());
    let refused = |name: &str| {
        let (status, stderr) = Collector::try_start(&scratch.0.join(name), &["--listen", &listen])
            .err()
            .expect("a collector must not start on a path that exists");
        assert!(!status.success(), "{name}: exited successfully");
        assert!(
            stderr.contains(&socket.display().to_string()) && stderr.contains("already exists"),
            "{name}: {stderr}"
        );
    };

    // A live collector's socket.
    let first = Collector::start(&scratch.0.join("first"), &["--listen", &listen]);
    refused("second");
    assert_eq!(
        first.get("/api/health").0,
        200,
        "the first collector lost its socket"
    );
    // Its own socket is gone after it stops cleanly.
    let (status, stderr, _) = first.stop();
    assert!(status.success(), "{stderr}");
    assert!(!socket.exists(), "the collector left its own socket behind");

    // A stale socket file that nothing listens on is refused too, and left where it is.
    drop(std::os::unix::net::UnixListener::bind(&socket).expect("a stale socket"));
    refused("third");
    assert!(
        socket.exists(),
        "the collector removed a path it did not create"
    );
    std::fs::remove_file(&socket).expect("remove the stale socket");

    // Someone else's socket at the path when the collector stops is left alone.
    let fourth = Collector::start(&scratch.0.join("fourth"), &["--listen", &listen]);
    std::fs::remove_file(&socket).expect("unlink the fourth collector's socket");
    let other = std::os::unix::net::UnixListener::bind(&socket).expect("another socket");
    let (status, stderr, _) = fourth.stop();
    assert!(status.success(), "{stderr}");
    assert!(
        socket.exists(),
        "the collector removed a socket it did not create"
    );
    UnixStream::connect(&socket).expect("the other socket still answers");
    drop(other);
}

#[test]
fn an_export_that_cannot_be_stored_is_not_acknowledged() {
    let scratch = Scratch::new("acknowledge");
    let collector = Collector::start(&scratch.data(), &[]);
    let trace = "0af7651916cd43dd8448eb211c80319c";
    // Another process holds the store's write lock for longer than the collector waits.
    let mut holder = Connection::open(scratch.database()).expect("open");
    let lock = holder
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("lock");
    let (status, body) = collector.post("/v1/traces", &small_export(trace, "b7ad6b7169203331"));
    assert_eq!(
        status, 500,
        "an export that was not stored was answered {status} {body}"
    );
    lock.rollback().expect("release");
    assert_eq!(count(&holder, "SELECT count(*) FROM spans"), 0);
    let (status, body) = collector.post("/v1/traces", &small_export(trace, "b7ad6b7169203331"));
    assert_eq!((status, body["insertedSpans"].as_u64()), (200, Some(1)));
    assert_eq!(count(&holder, "SELECT count(*) FROM spans"), 1);
}

#[test]
fn stopping_ends_within_its_budget_while_another_process_locks_the_store() {
    let scratch = Scratch::new("shutdown");
    let collector = Collector::start(&scratch.data(), &[]);
    let mut holder = Connection::open(scratch.database()).expect("open");
    let lock = holder
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("lock");
    // A refusal for the writer to save, and exports queued behind a store that cannot write.
    assert_eq!(collector.post("/v1/traces", b"{not json").0, 400);
    let address = collector.address.clone();
    let senders: Vec<_> = (0..3u8)
        .map(|index| {
            let address = address.clone();
            std::thread::spawn(move || {
                let span = format!("{:016x}", u64::from(index) + 1);
                let body = small_export("1111111111111111111111111111111a", &span);
                let mut raw = format!(
                    "POST /v1/traces HTTP/1.1\r\nHost: collector\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .into_bytes();
                raw.extend_from_slice(&body);
                let Address::Tcp(port) = address else { unreachable!() };
                let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
                stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
                stream.set_write_timeout(Some(IO_LIMIT)).expect("timeout");
                stream.write_all(&raw).expect("send");
                let mut response = Vec::new();
                let _ = stream.read_to_end(&mut response);
                String::from_utf8_lossy(&response).into_owned()
            })
        })
        .collect();
    std::thread::sleep(Duration::from_millis(100));
    let (status, stderr, took) = collector.stop_within(Duration::from_secs(4));
    assert!(
        took < Duration::from_millis(3_000),
        "stopping took {took:?}: {stderr}"
    );
    assert!(status.success(), "{status:?} {stderr}");
    // No export the store did not keep was acknowledged.
    lock.rollback().expect("release");
    let stored = count(&holder, "SELECT count(*) FROM spans");
    let acknowledged = senders
        .into_iter()
        .map(|sender| sender.join().expect("sender"))
        .filter(|response| response.starts_with("HTTP/1.1 200"))
        .count();
    assert_eq!(stored, acknowledged as i64);
}

/// The writer is still storing an export when the stop signal arrives, and would keep at it
/// long past the 2.5 s budget: another process gave the store a trigger that runs for minutes on
/// every span insert. The collector must exit within the budget anyway, without acknowledging the
/// export. The test waits at most 4 s for the exit, then kills the collector and fails.
#[test]
fn stopping_ends_within_its_budget_while_the_writer_is_still_storing() {
    let scratch = Scratch::new("slow-writer");
    let collector = Collector::start(&scratch.data(), &[]);
    let other = Connection::open(scratch.database()).expect("open");
    other
        .execute_batch(
            "CREATE TRIGGER slow BEFORE INSERT ON spans BEGIN
               SELECT count(*) FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000000000) SELECT i FROM n);
             END;",
        )
        .expect("trigger");
    let address = collector.address.clone();
    let sender = std::thread::spawn(move || {
        let body = small_export("2222222222222222222222222222222b", "b7ad6b7169203331");
        let mut raw = format!(
            "POST /v1/traces HTTP/1.1\r\nHost: collector\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        raw.extend_from_slice(&body);
        let Address::Tcp(port) = address else {
            unreachable!()
        };
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
        stream.write_all(&raw).expect("send");
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        String::from_utf8_lossy(&response).into_owned()
    });
    // The writer holds the store's write lock once it is inside the export's transaction.
    other.busy_timeout(Duration::ZERO).expect("busy timeout");
    let waiting = Instant::now();
    loop {
        match other.execute_batch("BEGIN IMMEDIATE; ROLLBACK;") {
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::DatabaseBusy =>
            {
                break;
            }
            Err(error) => panic!("probing the store's lock: {error}"),
            Ok(()) => {
                assert!(
                    waiting.elapsed() < Duration::from_secs(10),
                    "the writer never started storing the export"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    let (status, stderr, took) = collector.stop_within(Duration::from_secs(4));
    assert!(
        took < Duration::from_millis(3_000),
        "stopping took {took:?}: {stderr}"
    );
    assert!(status.success(), "{status:?} {stderr}");
    let response = sender.join().expect("sender");
    assert!(
        !response.starts_with("HTTP/1.1 200"),
        "an export the writer had not finished was acknowledged: {response}"
    );
    other
        .busy_timeout(Duration::from_secs(5))
        .expect("busy timeout");
    other
        .execute_batch("DROP TRIGGER slow;")
        .expect("drop trigger");
    assert_eq!(count(&other, "SELECT count(*) FROM spans"), 0);
}

#[test]
fn a_first_start_cut_off_while_creating_the_store_leaves_a_file_the_next_start_creates() {
    // A file-size limit stops the collector at a different point of creation each time: the
    // kernel ends it with SIGXFSZ when a file passes the limit. Whatever it left, the next start
    // creates or finishes the store; none leaves a file the next start refuses.
    for kib in [0, 1, 4, 8, 16, 32, 48, 64, 96] {
        let scratch = Scratch::new(&format!("create-{kib}"));
        std::fs::create_dir_all(scratch.data()).expect("data directory");
        if let Ok(started) = Collector::spawn(
            Command::new("bash")
                .arg("-c")
                .arg(format!("ulimit -c 0; ulimit -f {kib}; exec \"$0\" serve --data \"$1\" --listen 127.0.0.1:0"))
                .arg(BINARY)
                .arg(scratch.data()),
        ) {
            // The limit was enough for the whole of creation.
            let (status, stderr, _) = started.stop();
            assert!(status.success(), "{kib} KiB: {stderr}");
        }
        let collector =
            Collector::try_start(&scratch.data(), &[]).unwrap_or_else(|(status, stderr)| {
                panic!("{kib} KiB: the next start failed ({status:?}): {stderr}")
            });
        let (status, _) = collector.post(
            "/v1/traces",
            &small_export("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331"),
        );
        assert_eq!(status, 200, "{kib} KiB");
        let (status, stderr, _) = collector.stop();
        assert!(status.success(), "{kib} KiB: {stderr}");
        let connection = Connection::open(scratch.database()).expect("open");
        assert_eq!(
            count(&connection, "SELECT count(*) FROM spans"),
            1,
            "{kib} KiB"
        );
    }
}

#[test]
fn gzip_exports_are_accepted_and_bounded_after_decompression() {
    use flate2::{Compression, write::GzEncoder};
    let compress = |text: &[u8]| {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(text).expect("compress");
        encoder.finish().expect("compress")
    };
    let scratch = Scratch::new("gzip");
    let collector = Collector::start(&scratch.data(), &["--max-export-bytes", "100000"]);
    let encoded = |encoding: &str, body: &[u8]| {
        let mut raw = format!(
            "POST /v1/traces HTTP/1.1\r\nHost: collector\r\nContent-Type: application/json\r\nContent-Encoding: {encoding}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        raw.extend_from_slice(body);
        exchange(&collector.address, &raw)
    };
    let export = small_export("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331");
    let (status, body) = encoded("gzip", &compress(&export));
    assert_eq!((status, body["insertedSpans"].as_u64()), (200, Some(1)));
    // 2 MB of spaces compresses to a few KB but passes the 100 KB limit once decompressed.
    assert_eq!(encoded("gzip", &compress(&[b' '; 2_000_000])).0, 413);
    assert_eq!(encoded("gzip", b"not gzip").0, 400);
    assert_eq!(encoded("br", &export).0, 415);
    let ingest = collector.get("/api/ingest").1;
    assert_eq!(
        (
            ingest["refused"]["tooLarge"].as_u64(),
            ingest["refused"]["invalid"].as_u64()
        ),
        (Some(1), Some(2))
    );
}

/// A gzip body that expands far past the size limit is refused without being expanded in memory.
#[cfg(target_os = "linux")]
#[test]
fn a_gzip_bomb_is_refused_without_expanding_it() {
    use flate2::{Compression, write::GzEncoder};
    let scratch = Scratch::new("gzip-bomb");
    let collector = Collector::start(&scratch.data(), &["--max-export-bytes", "1000000"]);
    // 128 MiB of zeros compresses to about 130 KB.
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    let zeros = vec![0u8; 1 << 20];
    for _ in 0..128 {
        encoder.write_all(&zeros).expect("compress");
    }
    let bomb = encoder.finish().expect("compress");
    let mut raw = format!(
        "POST /v1/traces HTTP/1.1\r\nHost: collector\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bomb.len()
    )
    .into_bytes();
    raw.extend_from_slice(&bomb);
    assert_eq!(exchange(&collector.address, &raw).0, 413);
    let peak_kib: u64 = std::fs::read_to_string(format!("/proc/{}/status", collector.pid()))
        .expect("status")
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .and_then(|value| value.trim().trim_end_matches("kB").trim().parse().ok())
        .expect("VmHWM");
    assert!(
        peak_kib < 64 * 1024,
        "the collector's memory peaked at {peak_kib} KiB"
    );
}

/// 16 MiB, the default size limit, of deep nesting: as an attribute value and as an unknown field,
/// complete or only opening brackets. Each answers within a few seconds, the collector stays up,
/// and its memory stays within a few times the body. Complete exports keep every span.
#[cfg(target_os = "linux")]
#[test]
fn sixteen_mib_of_nesting_is_answered_in_bounded_time_and_memory() {
    const LIMIT: usize = 16 * 1024 * 1024;
    let trace = "0af7651916cd43dd8448eb211c80319c";
    // Three spans; the second has `attribute` among its attributes and `field` among its fields.
    let export = |attribute: &str, field: &str| {
        format!(
            r#"{{"resourceSpans":[{{"scopeSpans":[{{"spans":[{{"traceId":"{trace}","spanId":"b7ad6b7169203331"}},{{"traceId":"{trace}","spanId":"b7ad6b7169203332"{field},"attributes":[{attribute}]}},{{"traceId":"{trace}","spanId":"b7ad6b7169203333"}}]}}]}}]}}"#
        )
    };
    // `open` repeated, then `leaf`, then as many `close`, filling the body to the limit at `@`.
    let fill = |template: String, open: &str, leaf: &str, close: &str| {
        let room = LIMIT - (template.len() - 1) - leaf.len();
        let levels = room / (open.len() + close.len());
        let body = template.replacen(
            '@',
            &format!("{}{leaf}{}", open.repeat(levels), close.repeat(levels)),
            1,
        );
        assert!(body.len() <= LIMIT && body.len() > LIMIT - 64);
        body.into_bytes()
    };
    let in_value = export(r#"{"key":"deep","value":@}"#, "");
    let in_field = export("", r#","other":@"#);
    let leaf = r#"{"stringValue":"x"}"#;
    let cases = [
        (fill(in_value.clone(), "[", "", ""), 400),
        (fill(in_field.clone(), "[", "", ""), 400),
        (fill(in_field.clone(), "[", "", "]"), 200),
        (
            fill(
                in_value.clone(),
                r#"{"arrayValue":{"values":["#,
                leaf,
                "]}}",
            ),
            200,
        ),
        (
            fill(
                in_value.clone(),
                r#"{"kvlistValue":{"values":[{"key":"k","value":"#,
                leaf,
                "}]}}",
            ),
            200,
        ),
    ];
    for (index, (body, expected)) in cases.iter().enumerate() {
        let scratch = Scratch::new(&format!("deep-{index}"));
        let collector = Collector::start(&scratch.data(), &[]);
        let started = Instant::now();
        let (status, answer) = collector.post("/v1/traces", body);
        let took = started.elapsed();
        assert_eq!(status, *expected, "case {index}: {answer}");
        // At most 0.5 s in a release build, 2.5 s in a debug build.
        assert!(took < Duration::from_secs(10), "case {index} took {took:?}");
        assert_eq!(collector.get("/api/health").0, 200, "case {index}");
        let peak_kib: u64 = std::fs::read_to_string(format!("/proc/{}/status", collector.pid()))
            .expect("status")
            .lines()
            .find_map(|line| line.strip_prefix("VmHWM:"))
            .and_then(|value| value.trim().trim_end_matches("kB").trim().parse().ok())
            .expect("VmHWM");
        // At most about 90 MiB: the body, the value kept as text, and that text escaped as JSON
        // twice, once inside its list and once among the span's attributes.
        assert!(
            peak_kib < 128 * 1024,
            "case {index}: the collector's memory peaked at {peak_kib} KiB"
        );
        collector.stop();
        let connection = Connection::open(scratch.database()).expect("open");
        let spans = if *expected == 200 { 3 } else { 0 };
        assert_eq!(
            count(&connection, "SELECT count(*) FROM spans"),
            spans,
            "case {index}"
        );
    }
}

/// The stack of the threads that decode is the collector's own, not the environment's. Started
/// with `RUST_MIN_STACK=65536`, a value as deep as is decoded, inside 64 key-value lists,
/// overflowed a decoding thread's stack and ended the process.
#[test]
fn a_small_stack_in_the_environment_does_not_end_the_collector() {
    let scratch = Scratch::new("small-stack");
    let collector = Collector::spawn(
        Command::new(BINARY)
            .env("RUST_MIN_STACK", "65536")
            .arg("serve")
            .arg("--data")
            .arg(scratch.data())
            .args(["--listen", "127.0.0.1:0"]),
    )
    .unwrap_or_else(|(status, stderr)| {
        panic!("the collector did not start ({status:?}): {stderr}")
    });
    let trace = "0af7651916cd43dd8448eb211c80319c";
    let deep = format!(
        r#"{}{{"stringValue":"x"}}{}"#,
        r#"{"kvlistValue":{"values":[{"key":"k","value":"#.repeat(64),
        "}]}}".repeat(64)
    );
    let export = format!(
        r#"{{"resourceSpans":[{{"scopeSpans":[{{"spans":[{{"traceId":"{trace}","spanId":"b7ad6b7169203331"}},{{"traceId":"{trace}","spanId":"b7ad6b7169203332","attributes":[{{"key":"deep","value":{deep}}}]}},{{"traceId":"{trace}","spanId":"b7ad6b7169203333"}}]}}]}}]}}"#
    );
    let (status, answer) = collector.post("/v1/traces", export.as_bytes());
    assert_eq!(status, 200, "{answer}");
    assert_eq!(collector.get("/api/health").0, 200);
    let (exit, stderr, _) = collector.stop();
    assert!(exit.success(), "{exit:?}: {stderr}");
    let connection = Connection::open(scratch.database()).expect("open");
    assert_eq!(count(&connection, "SELECT count(*) FROM spans"), 3);
}

#[test]
fn refused_bytes_count_what_was_read_from_a_body_without_a_length() {
    let scratch = Scratch::new("bytes");
    // The smallest limit the collector takes.
    let collector = Collector::start(&scratch.data(), &["--max-export-bytes", "65536"]);
    let chunked = |payload: &[u8]| {
        let mut raw = b"POST /v1/traces HTTP/1.1\r\nHost: collector\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
        raw.extend_from_slice(format!("{:x}\r\n", payload.len()).as_bytes());
        raw.extend_from_slice(payload);
        raw.extend_from_slice(b"\r\n0\r\n\r\n");
        exchange(&collector.address, &raw)
    };
    assert_eq!(chunked(b"not json").0, 400);
    assert_eq!(collector.get("/api/ingest").1["refusedBytes"], 8);
    assert_eq!(chunked(&[b' '; 70_000]).0, 413);
    let refused = collector.get("/api/ingest").1["refusedBytes"]
        .as_u64()
        .expect("bytes");
    assert!(
        (8 + 65_537..=8 + 70_000).contains(&refused),
        "refusedBytes {refused}"
    );
}

/// Resident memory of a process, in KiB.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn resident_kib(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .expect("status")
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|value| value.trim().trim_end_matches("kB").trim().parse().ok())
        .expect("VmRSS")
}

/// Resident memory once it has stopped moving: sampled every 50 ms until six samples in a row
/// are within 256 KiB of each other (the writer returns memory 250 ms after the last work), at
/// most 5 s.
fn settled_resident_kib(pid: u32) -> u64 {
    let started = Instant::now();
    let mut window: Vec<u64> = Vec::new();
    loop {
        window.push(resident_kib(pid));
        if window.len() > 6 {
            window.remove(0);
        }
        let (low, high) = (
            window.iter().min().copied().unwrap_or(0),
            window.iter().max().copied().unwrap_or(0),
        );
        if (window.len() == 6 && high - low < 256) || started.elapsed() > Duration::from_secs(5) {
            return high;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Send `exports` at once, keeping the highest resident memory seen, then wait up to `within`
/// for the collector to return at least half of what they added. The readings, in KiB.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn burst(
    collector: &Collector,
    exports: Vec<Vec<u8>>,
    expected: u16,
    within: Duration,
) -> (u64, u64, u64) {
    let pid = collector.pid();
    let before = resident_kib(pid);
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher = {
        let done = done.clone();
        std::thread::spawn(move || {
            let mut peak = 0;
            while !done.load(std::sync::atomic::Ordering::SeqCst) {
                peak = peak.max(resident_kib(pid));
                std::thread::sleep(Duration::from_millis(10));
            }
            peak
        })
    };
    let address = collector.address.clone();
    let senders: Vec<_> = exports
        .into_iter()
        .map(|body| {
            let address = address.clone();
            std::thread::spawn(move || request(&address, "POST", "/v1/traces", Some(&body)).0)
        })
        .collect();
    for sender in senders {
        assert_eq!(sender.join().expect("sender"), expected);
    }
    done.store(true, std::sync::atomic::Ordering::SeqCst);
    let peak = watcher.join().expect("watcher").max(resident_kib(pid));
    let half = before + (peak - before) / 2;
    let answered = Instant::now();
    let mut after = resident_kib(pid);
    while after >= half && answered.elapsed() < within {
        std::thread::sleep(Duration::from_millis(100));
        after = resident_kib(pid);
    }
    (before, peak, after)
}

/// The memory scenario (`docker-release-collector-memory.spec.ts`) allows 20 s to return half
/// of a burst. Measured, this returned about 98% within half a second, so 10 s for half leaves a
/// wide margin. Refused exports allocate as much as stored ones before they are refused.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn resident_memory_comes_back_after_a_burst_stored_or_refused() {
    let scratch = Scratch::new("memory");
    let collector = Collector::start(&scratch.data(), &[]);
    let mut ids = Ids(0);
    for (name, bad, status) in [("stored", false, 200), ("refused", true, 400)] {
        let exports = (0..4)
            .map(|_| burst_export(&mut ids, 12_000, bad))
            .collect();
        let (before, peak, after) = burst(&collector, exports, status, Duration::from_secs(10));
        let used = peak - before;
        assert!(used > 16 * 1024, "{name}: the burst used only {used} KiB");
        assert!(
            after < before + used / 2,
            "{name}: 10 s after the burst the collector still held {} of the {used} KiB it used (before {before}, peak {peak})",
            after.saturating_sub(before)
        );
    }
}

/// Resident memory comes back after a burst that also starts eviction: retention's steps run
/// after the exports and must not keep what the burst used.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn resident_memory_comes_back_after_a_burst_that_starts_eviction() {
    let scratch = Scratch::new("memory-evicting");
    let collector = Collector::start(&scratch.data(), &["--max-store-mb", "8"]);
    let mut ids = Ids(1 << 40);
    let exports = (0..4)
        .map(|_| burst_export(&mut ids, 12_000, false))
        .collect();
    let (before, peak, after) = burst(&collector, exports, 200, Duration::from_secs(10));
    let used = peak - before;
    assert!(used > 16 * 1024, "the burst used only {used} KiB");
    assert!(
        after < before + used / 2,
        "10 s after the burst the collector still held {} of the {used} KiB it used (before {before}, peak {peak})",
        after.saturating_sub(before)
    );
    let ingest = wait_for_ingest(&collector, Duration::from_secs(30), |ingest| {
        ingest["store"]["maintenancePending"] == false
    });
    assert!(
        ingest["evictions"]["traces"].as_u64().expect("traces") > 0,
        "nothing was evicted: {ingest}"
    );
}

/// The largest file any collector started with `start_capped` may write. A test that breaks the
/// write-ahead log's bound fails at this size instead of filling the disk.
const FILE_CAP: u64 = 256 * 1024 * 1024;

unsafe extern "C" {
    fn setrlimit(resource: i32, limit: *const [u64; 2]) -> i32;
}

impl Collector {
    /// Start the binary with no file it writes allowed past `FILE_CAP` bytes.
    fn start_capped(data: &Path, extra: &[&str]) -> Collector {
        use std::os::unix::process::CommandExt;
        const RLIMIT_FSIZE: i32 = 1;
        let mut command = Command::new(BINARY);
        command
            .arg("serve")
            .arg("--data")
            .arg(data)
            .args(["--listen", "127.0.0.1:0"])
            .args(extra);
        // SAFETY: setrlimit is async-signal-safe and the limit lives on this stack frame.
        unsafe {
            command.pre_exec(|| {
                let limit = [FILE_CAP, FILE_CAP];
                if setrlimit(RLIMIT_FSIZE, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Collector::spawn(&mut command).unwrap_or_else(|(status, stderr)| {
            panic!("the collector did not start ({status:?}): {stderr}")
        })
    }
}

/// The bytes of every file in a directory.
fn directory_bytes(directory: &Path) -> u64 {
    std::fs::read_dir(directory).map_or(0, |entries| {
        entries
            .filter_map(|entry| entry.ok()?.metadata().ok())
            .map(|metadata| metadata.len())
            .sum()
    })
}

/// Read `/api/ingest` until `done` holds, for at most `limit`.
fn wait_for_ingest(collector: &Collector, limit: Duration, done: impl Fn(&Value) -> bool) -> Value {
    let started = Instant::now();
    loop {
        let (status, ingest) = collector.get("/api/ingest");
        assert_eq!(status, 200);
        if done(&ingest) {
            return ingest;
        }
        assert!(
            started.elapsed() < limit,
            "not done within {limit:?}: {ingest}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The incident of 13 Nov 2026, scaled down: sustained ingest at the store's bound while readers
/// hold the write-ahead log, one read after another. Before the log was bounded it grew about
/// 90 MB a second beside a database held at its bound. The whole data directory must stay
/// within the bound plus the log's limit plus what admitted exports add, at every reading, and
/// a log that cannot be emptied must turn into refused exports.
#[test]
fn the_write_ahead_log_stays_bounded_under_sustained_ingest_while_readers_hold_it() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    let scratch = Scratch::new("wal-bound");
    let bound_mb = 16;
    let collector = Arc::new(Collector::start_capped(
        &scratch.data(),
        &["--max-store-mb", &bound_mb.to_string()],
    ));
    // The bound with eviction's 10% allowance, the log's refusal size, three admitted exports of
    // 1,500 spans and the index file, with room to spare: under 64 MiB.
    let limit = 64 * 1024 * 1024;
    let stop = Arc::new(AtomicBool::new(false));
    let acknowledged = Arc::new(AtomicU64::new(0));
    let senders: Vec<_> = (0..3u64)
        .map(|sender| {
            let (stop, acknowledged, address) = (
                stop.clone(),
                acknowledged.clone(),
                collector.address.clone(),
            );
            std::thread::spawn(move || {
                let mut ids = Ids((sender + 2) << 40);
                while !stop.load(Ordering::SeqCst) {
                    let body = burst_export(&mut ids, 1_500, false);
                    let status = post_refusable(&address, &body);
                    assert!(
                        matches!(status, None | Some(200 | 429)),
                        "an export got {status:?}"
                    );
                    if status == Some(200) {
                        acknowledged.fetch_add(1, Ordering::SeqCst);
                    }
                }
            })
        })
        .collect();
    let reader = {
        let (stop, database) = (stop.clone(), scratch.database());
        std::thread::spawn(move || {
            let started = Instant::now();
            while !database.exists() {
                assert!(started.elapsed() < START_LIMIT);
                std::thread::yield_now();
            }
            let connection =
                Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .expect("reader");
            // One read after another, each held for 1 s, as long as the load runs.
            while !stop.load(Ordering::SeqCst) {
                connection.execute_batch("BEGIN").expect("begin");
                let _: i64 = connection
                    .query_row("SELECT count(*) FROM traces", [], |row| row.get(0))
                    .expect("read");
                std::thread::sleep(Duration::from_secs(1));
                connection.execute_batch("COMMIT").expect("commit");
            }
        })
    };
    // The load runs until the log has filled (exports refused) and been emptied twice while the
    // readers turn over, at most 60 s, the directory sampled throughout. With each read starting
    // as the last ends, emptying a full log takes up to two reads: the first new reader's
    // snapshot still includes frames not yet copied, the next finds the log copied and reads only
    // the database. Anything written to the full log meanwhile starts that over.
    let started = Instant::now();
    let mut largest = 0;
    let mut breach = None;
    let mut during = Value::Null;
    let mut sampled = Instant::now();
    while started.elapsed() < Duration::from_secs(60) {
        let bytes = directory_bytes(&scratch.data());
        largest = largest.max(bytes);
        if bytes > limit {
            breach = Some((started.elapsed(), bytes));
            break;
        }
        if sampled.elapsed() >= Duration::from_millis(250) {
            sampled = Instant::now();
            during = collector.get("/api/ingest").1;
            if during["store"]["walEmptied"].as_u64() >= Some(2)
                && during["refused"]["overBound"].as_u64() > Some(0)
                && started.elapsed() >= Duration::from_secs(5)
            {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    eprintln!(
        "walEmptied during the load: {}",
        during["store"]["walEmptied"]
    );
    stop.store(true, Ordering::SeqCst);
    for sender in senders {
        sender.join().expect("sender");
    }
    reader.join().expect("reader");
    if let Some((at, bytes)) = breach {
        panic!("the data directory held {bytes} bytes {at:?} into the load, over {limit}");
    }
    assert!(
        during["store"]["walEmptied"].as_u64().expect("walEmptied") >= 2,
        "the log was emptied fewer than twice in 60 s of 1-second readers: {during}"
    );
    // With the reader gone, the log empties, eviction catches up with the exports admitted while
    // it was paused, and exports are stored again.
    let ingest = wait_for_ingest(&collector, Duration::from_secs(30), |ingest| {
        ingest["store"]["walFull"] == false && ingest["store"]["maintenancePending"] == false
    });
    assert!(
        ingest["refused"]["overBound"].as_u64().expect("overBound") > 0,
        "the readers never filled the log, so the test did not test the bound: {ingest}"
    );
    assert!(
        acknowledged.load(Ordering::SeqCst) > 0,
        "nothing was stored"
    );
    let mut ids = Ids(9 << 40);
    let (status, _) = collector.post("/v1/traces", &burst_export(&mut ids, 30, false));
    assert_eq!(status, 200, "an export after the readers left was refused");
    eprintln!("largest data directory {largest} bytes; {ingest}");
}

/// Post a traces export that the collector may refuse before reading its body. Closing the
/// connection with the body unread can reset it before the 429 is read, which a sender sees as
/// a lost connection and retries like a 429. `None` for that, or for a connection that ended with
/// no answer at all.
fn post_refusable(address: &Address, body: &[u8]) -> Option<u16> {
    let Address::Tcp(port) = address else {
        panic!("a TCP collector")
    };
    let mut raw = format!(
        "POST /v1/traces HTTP/1.1\r\nHost: collector\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    raw.extend_from_slice(body);
    let mut stream = TcpStream::connect(("127.0.0.1", *port)).expect("connect");
    stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
    stream.set_write_timeout(Some(IO_LIMIT)).expect("timeout");
    let _ = stream.write_all(&raw);
    let mut response = Vec::new();
    match stream.read_to_end(&mut response) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => return None,
        Err(error) => panic!("receive: {error}"),
    }
    if response.is_empty() {
        return None;
    }
    Some(received(&response).0)
}

/// One export of `spans` spans of the trace `trace`, starting at span number `first`.
fn trace_export(trace: &str, first: u64, spans: u64) -> Vec<u8> {
    // Ten minutes ago, so every list's lookback includes the trace.
    let base: u64 = ago(600.0).parse().expect("time");
    let rows: Vec<String> = (first..first + spans)
        .map(|span| {
            format!(
                r#"{{"traceId":"{trace}","spanId":"{:016x}","name":"step","startTimeUnixNano":"{}","endTimeUnixNano":"{}","attributes":[{{"key":"k","value":{{"stringValue":"{}"}}}}]}}"#,
                span + 1,
                base + span,
                base + 1_000 + span,
                "v".repeat(200)
            )
        })
        .collect();
    format!(
        r#"{{"resourceSpans":[{{"resource":{{"attributes":[{{"key":"service.name","value":{{"stringValue":"big"}}}}]}},"scopeSpans":[{{"spans":[{}]}}]}}]}}"#,
        rows.join(",")
    )
    .into_bytes()
}

/// A drain killed with SIGKILL at any point, here as soon as each start has taken a step, leaves
/// a store the next start opens and finishes draining. The oldest trace has 30,000 spans, so
/// kills land while it is part evicted.
#[test]
fn a_drain_killed_part_way_finishes_after_a_restart_and_leaves_a_consistent_store() {
    let scratch = Scratch::new("kill-drain");
    {
        let collector = Collector::start(&scratch.data(), &[]);
        for part in 0..6 {
            let (status, _) = collector.post(
                "/v1/traces",
                &trace_export("0000000000000000000000000000beef", part * 5_000, 5_000),
            );
            assert_eq!(status, 200);
        }
        let mut ids = Ids(3 << 40);
        for _ in 0..20 {
            let (status, _) = collector.post("/v1/traces", &burst_export(&mut ids, 1_000, false));
            assert_eq!(status, 200);
        }
        let (status, _, _) = collector.stop();
        assert!(status.success());
    }
    let bound = ["--max-store-mb", "2"];
    for _ in 0..6 {
        let mut collector = Collector::start(&scratch.data(), &bound);
        wait_for_ingest(&collector, Duration::from_secs(30), |ingest| {
            ingest["store"]["steps"]
                .as_u64()
                .is_some_and(|steps| steps > 0)
        });
        collector.process.0.kill().expect("SIGKILL");
        collector.process.wait_within(EXIT_LIMIT);
    }
    let collector = Collector::start(&scratch.data(), &bound);
    let ingest = wait_for_ingest(&collector, Duration::from_secs(60), |ingest| {
        ingest["store"]["maintenancePending"] == false
    });
    assert!(ingest["store"]["usedBytes"].as_u64().expect("used") <= 2 * 1024 * 1024 / 100 * 90);
    let (status, _, _) = collector.stop();
    assert!(status.success());
    let connection = Connection::open(scratch.database()).expect("open");
    for (what, sql) in [
        (
            "spans without their trace",
            "SELECT count(*) FROM spans WHERE trace NOT IN (SELECT id FROM traces)",
        ),
        (
            "logs without their resource",
            "SELECT count(*) FROM logs WHERE resource NOT IN (SELECT id FROM resources)",
        ),
        (
            "spans without their resource",
            "SELECT count(*) FROM spans WHERE resource NOT IN (SELECT id FROM resources)",
        ),
        (
            "resources nothing refers to",
            "SELECT count(*) FROM resources WHERE id NOT IN (SELECT resource FROM spans) AND id NOT IN (SELECT resource FROM logs)",
        ),
        (
            "a trace left part evicted",
            "SELECT count(*) FROM meta WHERE key = 'evicting'",
        ),
        (
            "traces whose span count is wrong",
            "SELECT count(*) FROM traces WHERE span_count != (SELECT count(*) FROM spans WHERE trace = traces.id)",
        ),
        (
            "the big trace",
            "SELECT count(*) FROM traces WHERE hex(trace_id) = '0000000000000000000000000000BEEF'",
        ),
    ] {
        assert_eq!(count(&connection, sql), 0, "{what}");
    }
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("integrity_check");
    assert_eq!(integrity, "ok");
}

/// A store of this collector's format, with spans, then closed with only its format changed to
/// `version`.
fn store_of_format(scratch: &Scratch, version: i64, exports: usize) {
    {
        let collector = Collector::start(&scratch.data(), &[]);
        let mut ids = Ids(4 << 40);
        for _ in 0..exports {
            let (status, _) = collector.post("/v1/traces", &burst_export(&mut ids, 1_000, false));
            assert_eq!(status, 200);
        }
        let (status, _, _) = collector.stop();
        assert!(status.success());
    }
    Connection::open(scratch.database())
        .expect("open")
        .execute_batch(&format!("PRAGMA user_version = {version};"))
        .expect("format");
}

/// A store of ours in another format is emptied in place at start, with one log line: the same
/// file, files beside it untouched.
#[test]
fn a_store_of_another_format_is_emptied_in_place_at_start() {
    use executor_collector::store::FORMAT;
    use std::os::unix::fs::MetadataExt;
    let scratch = Scratch::new("reset");
    store_of_format(&scratch, FORMAT - 1, 2);
    std::fs::write(scratch.data().join("collector.json"), "{}").expect("neighbour");
    let inode = std::fs::metadata(scratch.database()).expect("store").ino();
    let collector = Collector::start(&scratch.data(), &[]);
    let mut ids = Ids(5 << 40);
    let (status, _) = collector.post("/v1/traces", &burst_export(&mut ids, 30, false));
    assert_eq!(status, 200);
    let (status, stderr, _) = collector.stop();
    assert!(status.success());
    assert_eq!(
        stderr.matches("emptied the telemetry store").count(),
        1,
        "{stderr}"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.data().join("collector.json")).expect("kept"),
        "{}"
    );
    assert_eq!(
        std::fs::metadata(scratch.database()).expect("store").ino(),
        inode,
        "the file was replaced"
    );
    let connection = Connection::open(scratch.database()).expect("open");
    assert_eq!(count(&connection, "PRAGMA user_version"), FORMAT);
    assert_eq!(count(&connection, "SELECT count(*) FROM spans"), 30);
}

/// Emptying a store is all or nothing: killed at any moment, or unable to write its log, the
/// store is either the old one, whole, or this format's, empty; the next start finishes.
#[test]
fn emptying_a_store_cut_off_part_way_leaves_the_old_store_or_the_new_one() {
    use executor_collector::store::FORMAT;
    // The whole store: its schema and every row of every table.
    let dump = |scratch: &Scratch| -> Vec<String> {
        let connection = Connection::open(scratch.database()).expect("open");
        let mut lines: Vec<String> = connection
            .prepare("SELECT type || ' ' || name || ' ' || coalesce(sql, '') FROM sqlite_schema ORDER BY type, name")
            .expect("schema")
            .query_map([], |row| row.get(0))
            .expect("rows")
            .map(|line| line.expect("line"))
            .collect();
        let tables: Vec<String> = connection
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .expect("tables")
            .query_map([], |row| row.get(0))
            .expect("names")
            .map(|name| name.expect("name"))
            .collect();
        for table in tables {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM \"{table}\""))
                .expect("select");
            let columns = statement.column_count();
            lines.extend(
                statement
                    .query_map([], |row| {
                        Ok((0..columns)
                            .map(|index| {
                                format!(
                                    "{:?}",
                                    row.get_ref(index).map(|value| format!("{value:?}"))
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(" | "))
                    })
                    .expect("rows")
                    .map(|row| format!("{table}: {}", row.expect("row"))),
            );
        }
        lines.push(format!(
            "format {}",
            count(&connection, "PRAGMA user_version")
        ));
        lines
    };
    // Either the old store, all of it, or the new one, empty.
    let check = |scratch: &Scratch, old: &[String], case: &str| {
        let now = dump(scratch);
        let connection = Connection::open(scratch.database()).expect("open");
        let emptied = count(&connection, "PRAGMA user_version") == FORMAT
            && count(&connection, "SELECT count(*) FROM spans") == 0
            && count(&connection, "SELECT count(*) FROM traces") == 0
            && count(&connection, "SELECT count(*) FROM resources") == 0;
        assert!(
            now == old || emptied,
            "{case}: neither the old store nor an empty new one"
        );
    };
    let finish = |scratch: &Scratch, case: &str| {
        let collector =
            Collector::try_start(&scratch.data(), &[]).unwrap_or_else(|(status, stderr)| {
                panic!("{case}: the next start failed ({status:?}): {stderr}")
            });
        let (status, _, _) = collector.stop();
        assert!(status.success(), "{case}");
        let connection = Connection::open(scratch.database()).expect("open");
        assert_eq!(
            (
                count(&connection, "PRAGMA user_version"),
                count(&connection, "SELECT count(*) FROM spans")
            ),
            (FORMAT, 0),
            "{case}"
        );
    };
    // Killed after each delay from its start.
    for delay_ms in [0u64, 2, 5, 10, 20, 40] {
        let scratch = Scratch::new(&format!("reset-kill-{delay_ms}"));
        store_of_format(&scratch, FORMAT - 1, 20);
        let old = dump(&scratch);
        let mut child = Owned(
            Command::new(BINARY)
                .arg("serve")
                .arg("--data")
                .arg(scratch.data())
                .args(["--listen", "127.0.0.1:0"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn"),
        );
        std::thread::sleep(Duration::from_millis(delay_ms));
        let _ = child.0.kill();
        child.wait_within(EXIT_LIMIT);
        check(&scratch, &old, &format!("killed after {delay_ms} ms"));
        finish(&scratch, &format!("killed after {delay_ms} ms"));
    }
    // Unable to grow its write-ahead log far enough: the start fails and changes nothing.
    let scratch = Scratch::new("reset-capped");
    store_of_format(&scratch, FORMAT - 1, 20);
    let old = dump(&scratch);
    let refused = Collector::spawn(
        Command::new("bash")
            .arg("-c")
            .arg("ulimit -c 0; ulimit -f 40; exec \"$0\" serve --data \"$1\" --listen 127.0.0.1:0")
            .arg(BINARY)
            .arg(scratch.data()),
    );
    assert!(
        refused.is_err(),
        "the capped start finished emptying the store"
    );
    assert_eq!(dump(&scratch), old, "capped: the store changed");
    finish(&scratch, "capped");
}

/// One collector per directory: of two started together, exactly one runs and the other exits
/// changing nothing; a third started while it runs is refused the same way; no export the
/// running one acknowledged is lost.
#[test]
fn one_collector_runs_per_directory() {
    for round in 0..4 {
        let scratch = Scratch::new(&format!("two-{round}"));
        // A lock file with bytes in it, an hour old: no start may truncate or touch it.
        std::fs::create_dir_all(scratch.data()).expect("data");
        let lock = scratch.data().join("telemetry.lock");
        std::fs::write(&lock, b"synthetic lock contents").expect("seed the lock");
        let old = std::time::SystemTime::now() - Duration::from_secs(3_600);
        std::fs::File::options()
            .write(true)
            .open(&lock)
            .and_then(|file| file.set_modified(old))
            .expect("age the lock");
        let seeded = || {
            let metadata = std::fs::metadata(&lock).expect("lock");
            (
                std::fs::read(&lock).expect("lock"),
                metadata.modified().expect("mtime"),
            )
        };
        let before = seeded();
        let starts: Vec<_> = (0..2)
            .map(|_| {
                let data = scratch.data();
                std::thread::spawn(move || Collector::try_start(&data, &[]))
            })
            .collect();
        let mut results: Vec<_> = starts
            .into_iter()
            .map(|start| start.join().expect("start"))
            .collect();
        let refused = results.iter().filter(|result| result.is_err()).count();
        assert_eq!(refused, 1, "round {round}: {} of 2 started", 2 - refused);
        let index = results
            .iter()
            .position(|result| result.is_ok())
            .expect("one started");
        let Ok(collector) = results.remove(index) else {
            unreachable!("the started one")
        };
        let Some(Err((status, stderr))) = results.pop() else {
            panic!("the other start was not refused")
        };
        assert!(!status.success());
        assert!(stderr.contains("another collector is using"), "{stderr}");
        let (status, _) = collector.post(
            "/v1/traces",
            &small_export("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331"),
        );
        assert_eq!(status, 200);
        let Err((status, stderr)) = Collector::try_start(&scratch.data(), &[]) else {
            panic!("a third start was not refused")
        };
        assert!(
            !status.success() && stderr.contains("another collector is using"),
            "{stderr}"
        );
        assert_eq!(
            seeded(),
            before,
            "round {round}: a start changed the lock file"
        );
        let (status, _) = collector.post(
            "/v1/traces",
            &small_export("0af7651916cd43dd8448eb211c80319c", "00f067aa0ba902b7"),
        );
        assert_eq!(status, 200);
        let (status, _, _) = collector.stop();
        assert!(status.success());
        let connection = Connection::open(scratch.database()).expect("open");
        assert_eq!(
            count(&connection, "SELECT count(*) FROM spans"),
            2,
            "round {round}: an acknowledged export was lost"
        );
    }
}

/// `--data` as a link to a directory, with a trailing slash, relative, and `.`: each uses the
/// directory it names.
#[test]
fn the_data_directory_may_be_named_any_way() {
    let scratch = Scratch::new("data-forms");
    let real = scratch.0.join("real");
    std::fs::create_dir_all(&real).expect("real");
    std::os::unix::fs::symlink(&real, scratch.0.join("link")).expect("link");
    let forms: [(&str, &Path, String); 4] = [
        (
            "link",
            &scratch.0,
            scratch.0.join("link").display().to_string(),
        ),
        ("trailing slash", &scratch.0, format!("{}/", real.display())),
        ("relative", &scratch.0, "real".to_owned()),
        ("dot", &real, ".".to_owned()),
    ];
    for (number, (name, cwd, data)) in forms.into_iter().enumerate() {
        let collector = Collector::spawn(Command::new(BINARY).current_dir(cwd).args([
            "serve",
            "--data",
            &data,
            "--listen",
            "127.0.0.1:0",
        ]))
        .unwrap_or_else(|(status, stderr)| panic!("{name}: did not start ({status:?}): {stderr}"));
        let (status, _) = collector.post(
            "/v1/traces",
            &small_export(
                "0af7651916cd43dd8448eb211c80319c",
                &format!("{:016x}", number + 1),
            ),
        );
        assert_eq!(status, 200, "{name}");
        let (status, stderr, _) = collector.stop();
        assert!(status.success(), "{name}: {stderr}");
        let connection = Connection::open(real.join("telemetry.sqlite")).expect("open");
        assert_eq!(
            count(&connection, "SELECT count(*) FROM spans"),
            number as i64 + 1,
            "{name}"
        );
    }
    assert!(
        std::fs::symlink_metadata(scratch.0.join("link"))
            .expect("link")
            .file_type()
            .is_symlink()
    );
}

/// The figures `/api/ingest` gives right after an export is acknowledged already show the
/// retention it causes: a caller that awaits an export and then waits for `maintenancePending`
/// to be false sees the drain the export started, not figures from before it.
#[test]
fn the_first_status_after_an_export_is_a_valid_synchronisation_point() {
    for round in 0..3 {
        let scratch = Scratch::new(&format!("sync-{round}"));
        let collector = Collector::start(&scratch.data(), &["--max-store-mb", "1"]);
        let mut ids = Ids((30 + round) << 40);
        let (status, _) = collector.post("/v1/traces", &burst_export(&mut ids, 12_000, false));
        assert_eq!(status, 200);
        let (_, first) = collector.get("/api/ingest");
        let store = &first["store"];
        assert!(
            store["maintenancePending"] == true
                || store["usedBytes"].as_u64() <= store["maxBytes"].as_u64(),
            "round {round}: the first status after the export shows no work and a store within its bound it is not: {first}"
        );
        assert!(
            store["usedBytes"].as_u64() > Some(1024 * 1024),
            "round {round}: the export's size is not in the first status: {first}"
        );
        let done = wait_for_ingest(&collector, Duration::from_secs(30), |ingest| {
            ingest["store"]["maintenancePending"] == false
        });
        assert!(
            done["store"]["usedBytes"].as_u64() <= done["store"]["maxBytes"].as_u64(),
            "{done}"
        );
    }
}

/// With `RUST_MIN_STACK` set small, storing a large trace and evicting it in steps still works.
/// No thread in the crate takes its stack size from the environment. This test does not prove
/// that rule by itself: the writer's own stack use on these paths fits in 16 KiB, so it passes
/// with an inherited size too. It catches a path that needs more.
#[test]
fn a_small_rust_min_stack_does_not_shrink_the_collectors_threads() {
    let scratch = Scratch::new("min-stack");
    let mut command = Command::new(BINARY);
    command
        .arg("serve")
        .arg("--data")
        .arg(scratch.data())
        .args(["--listen", "127.0.0.1:0", "--max-store-mb", "2"])
        .env("RUST_MIN_STACK", "65536");
    let collector = Collector::spawn(&mut command).unwrap_or_else(|(status, stderr)| {
        panic!("the collector did not start ({status:?}): {stderr}")
    });
    for part in 0..2 {
        let (status, _) = collector.post(
            "/v1/traces",
            &trace_export("00000000000000000000000000000abc", part * 5_000, 5_000),
        );
        assert_eq!(status, 200);
    }
    let mut ids = Ids(5 << 40);
    for _ in 0..5 {
        let (status, _) = collector.post("/v1/traces", &burst_export(&mut ids, 1_000, false));
        assert_eq!(status, 200);
    }
    let ingest = wait_for_ingest(&collector, Duration::from_secs(30), |ingest| {
        ingest["store"]["maintenancePending"] == false
    });
    assert!(
        ingest["evictions"]["traces"].as_u64().expect("traces") > 0,
        "{ingest}"
    );
    let (status, stderr, _) = collector.stop();
    assert!(status.success(), "{stderr}");
    // Every kind of query, and a whole 20,000-span trace read, on readers under the same
    // environment.
    let scratch = Scratch::new("min-stack-queries");
    let mut command = Command::new(BINARY);
    command
        .arg("serve")
        .arg("--data")
        .arg(scratch.data())
        .args(["--listen", "127.0.0.1:0"])
        .env("RUST_MIN_STACK", "65536");
    let collector = Collector::spawn(&mut command).unwrap_or_else(|(status, stderr)| {
        panic!("the collector did not start ({status:?}): {stderr}")
    });
    send_corpus(&collector);
    let big = "00000000000000000000000000000def";
    send_large_trace(&collector, big, 20_000);
    for query in [
        "/api/services".to_owned(),
        "/api/traces?lookback=1d".to_owned(),
        "/api/traces/stats?groupBy=operation&agg=count".to_owned(),
        format!("/api/traces/{TREE}"),
        format!("/api/traces/{ORPHANS}/spans"),
        format!("/api/traces/{TREE}/logs"),
        "/api/spans/search?operation=http.request&lookback=1d&attr.http.route=%2Fapi%2Fusers_list"
            .to_owned(),
        "/api/logs/search?body=cafe&lookback=1d".to_owned(),
        "/api/logs?severity=warn&lookback=1d".to_owned(),
    ] {
        let (status, body) = collector.get(&query);
        assert_eq!(status, 200, "{query}: {body}");
        assert!(
            body["data"].as_array().is_none_or(|data| !data.is_empty()),
            "{query}: {body}"
        );
    }
    let (status, body) = collector.get(&format!("/api/traces/{big}"));
    assert_eq!(status, 200);
    assert_eq!(body["data"]["spans"].as_array().map(Vec::len), Some(20_000));
    let (status, stderr, _) = collector.stop();
    assert!(status.success(), "{stderr}");
}

// --- Queries ---------------------------------------------------------------------------------

/// Now, in nanoseconds, less `seconds_ago`.
fn ago(seconds_ago: f64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos() as i128;
    (now - (seconds_ago * 1e9) as i128).to_string()
}

fn otlp_spans(service: &str, spans: Vec<Value>) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "resourceSpans": [{
        "resource": { "attributes": [
            { "key": "service.name", "value": { "stringValue": service } },
            { "key": "deployment.environment.name", "value": { "stringValue": "test" } },
        ] },
        "scopeSpans": [{ "scope": { "name": "test" }, "spans": spans }],
    }] }))
    .expect("json")
}

fn otlp_logs(service: &str, logs: Vec<Value>) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "resourceLogs": [{
        "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": service } }] },
        "scopeLogs": [{ "scope": { "name": "test.logs" }, "logRecords": logs }],
    }] }))
    .expect("json")
}

const TREE: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const ORPHANS: &str = "5bf92f3577b34da6a3ce929d0e0e4736";

/// The same kinds of telemetry the comparison with Motel sent (`collector-diff`): a tree over
/// two services with every attribute type, events, every kind and an error; missing parents and
/// a running span; logs with trace ids on the record and in attributes, and without.
fn send_corpus(collector: &Collector) {
    use serde_json::json;
    let attribute = |key: &str, value: Value| json!({ "key": key, "value": value });
    let exports = [
        otlp_spans(
            "api",
            vec![
                json!({ "traceId": TREE, "spanId": "00f067aa0ba90201", "name": "http.request GET /api/users_list", "kind": 2,
                    "startTimeUnixNano": ago(120.0), "endTimeUnixNano": ago(119.0),
                    "attributes": [
                        attribute("http.route", json!({ "stringValue": "/api/users_list" })),
                        attribute("http.status_code", json!({ "intValue": "200" })),
                        attribute("ratio", json!({ "doubleValue": 0.25 })),
                        attribute("flag", json!({ "boolValue": true })),
                        attribute("list", json!({ "arrayValue": { "values": [{ "stringValue": "a" }, { "intValue": "2" }] } })),
                        attribute("map", json!({ "kvlistValue": { "values": [{ "key": "x", "value": { "stringValue": "y" } }] } })),
                        attribute("raw", json!({ "bytesValue": "AQID" })),
                    ],
                    "events": [{ "name": "started", "timeUnixNano": ago(119.9), "attributes": [attribute("phase", json!({ "stringValue": "one" }))] }] }),
                json!({ "traceId": TREE, "spanId": "00f067aa0ba90202", "parentSpanId": "00f067aa0ba90201", "name": "db.query select",
                    "kind": 3, "startTimeUnixNano": ago(119.8), "endTimeUnixNano": ago(119.7), "status": { "code": 2 } }),
                json!({ "traceId": TREE, "spanId": "00f067aa0ba90203", "parentSpanId": "00f067aa0ba90201", "name": "executor.tool.call",
                    "kind": 4, "startTimeUnixNano": ago(119.6), "endTimeUnixNano": ago(119.2) }),
            ],
        ),
        otlp_spans(
            "worker",
            vec![
                json!({ "traceId": TREE, "spanId": "00f067aa0ba90204", "parentSpanId": "00f067aa0ba90203", "name": "executor.tool_call.inner",
                    "kind": 5, "startTimeUnixNano": ago(119.5), "endTimeUnixNano": ago(119.3) }),
                json!({ "traceId": TREE, "spanId": "00f067aa0ba90205", "parentSpanId": "00f067aa0ba90204", "name": "cafe step",
                    "kind": 0, "startTimeUnixNano": ago(119.4), "endTimeUnixNano": ago(119.35) }),
                json!({ "traceId": ORPHANS, "spanId": "00f067aa0ba90301", "parentSpanId": "00f067aa0ba903f1", "name": "orphan.one",
                    "startTimeUnixNano": ago(100.0), "endTimeUnixNano": ago(99.0) }),
                json!({ "traceId": ORPHANS, "spanId": "00f067aa0ba90302", "parentSpanId": "00f067aa0ba903f1", "name": "orphan.two",
                    "startTimeUnixNano": ago(99.5), "endTimeUnixNano": ago(99.1) }),
                json!({ "traceId": ORPHANS, "spanId": "00f067aa0ba90303", "parentSpanId": "00f067aa0ba903f2", "name": "orphan.three",
                    "startTimeUnixNano": ago(98.0), "endTimeUnixNano": "0" }),
            ],
        ),
    ];
    for body in exports {
        assert_eq!(collector.post("/v1/traces", &body).0, 200);
    }
    let logs = otlp_logs(
        "worker",
        vec![
            json!({ "timeUnixNano": ago(119.5), "severityText": "ERROR", "body": { "stringValue": "tool failed: café timeout" }, "traceId": TREE, "spanId": "00f067aa0ba90203" }),
            json!({ "timeUnixNano": ago(119.4), "body": { "stringValue": "attribute ids" },
                "attributes": [attribute("traceId", json!({ "stringValue": TREE })), attribute("span_id", json!({ "stringValue": "00f067aa0ba90204" }))] }),
            json!({ "observedTimeUnixNano": ago(99.0), "body": { "stringValue": "observed only" }, "traceId": ORPHANS }),
            json!({ "timeUnixNano": ago(30.0), "severityText": "WARN", "body": { "kvlistValue": { "values": [attribute("k", json!({ "stringValue": "v" }))] } } }),
        ],
    );
    assert_eq!(collector.post("/v1/logs", &logs).0, 200);
}

/// A JSON value's shape as `collector-diff`'s `shapeOf` writes it: each field's JSON types,
/// merged over every array element; `tags` and `attributes` as records.
fn shape_of(value: &Value, key: &str) -> Value {
    use serde_json::json;
    fn merge(a: &Value, b: &Value) -> Value {
        let mut types: Vec<String> = a["types"]
            .as_array()
            .into_iter()
            .chain(b["types"].as_array())
            .flatten()
            .map(|kind| kind.as_str().expect("type").to_owned())
            .collect();
        types.sort();
        types.dedup();
        let mut shape = json!({ "types": types });
        if a.get("fields").is_some() || b.get("fields").is_some() {
            let mut fields = serde_json::Map::new();
            for side in [a, b] {
                for (name, field) in side["fields"].as_object().into_iter().flatten() {
                    let merged = match fields.get(name) {
                        Some(existing) => merge(existing, field),
                        None => field.clone(),
                    };
                    fields.insert(name.clone(), merged);
                }
            }
            shape["fields"] = Value::Object(fields);
        }
        match (a.get("items"), b.get("items")) {
            (Some(x), Some(y)) => shape["items"] = merge(x, y),
            (Some(x), None) | (None, Some(x)) => shape["items"] = x.clone(),
            _ => {}
        }
        shape
    }
    let kind = |name: &str| json!({ "types": [name] });
    match value {
        Value::Null => kind("null"),
        Value::Bool(_) => kind("boolean"),
        Value::Number(_) => kind("number"),
        Value::String(_) => kind("string"),
        Value::Array(items) => {
            let mut shape = kind("array");
            if let Some(items) = items
                .iter()
                .map(|item| shape_of(item, ""))
                .reduce(|a, b| merge(&a, &b))
            {
                shape["items"] = items;
            }
            shape
        }
        Value::Object(map) if key == "tags" || key == "attributes" => {
            let mut shape = kind("object");
            if let Some(values) = map
                .values()
                .map(|item| shape_of(item, ""))
                .reduce(|a, b| merge(&a, &b))
            {
                shape["fields"] = json!({ "*": values });
            }
            shape
        }
        Value::Object(map) => {
            let mut shape = kind("object");
            shape["fields"] = Value::Object(
                map.iter()
                    .map(|(name, item)| (name.clone(), shape_of(item, name)))
                    .collect(),
            );
            shape
        }
    }
}

/// Every field of `ours` is one of Motel's with types Motel gave it, and every field Motel gave
/// is there. A field Motel returned as either null or a string may be just one of them here.
fn assert_shape(route: &str, path: &str, motel: &Value, ours: &Value) {
    let types = |shape: &Value| -> Vec<String> {
        shape["types"]
            .as_array()
            .expect("types")
            .iter()
            .map(|kind| kind.as_str().expect("type").to_owned())
            .collect()
    };
    for kind in types(ours) {
        assert!(
            types(motel).contains(&kind),
            "{route}{path}: type {kind}, Motel's {:?}",
            types(motel)
        );
    }
    let (motel_fields, our_fields) = (motel["fields"].as_object(), ours["fields"].as_object());
    if let (Some(motel_fields), Some(our_fields)) = (motel_fields, our_fields) {
        let mut motel_names: Vec<_> = motel_fields.keys().collect();
        let mut our_names: Vec<_> = our_fields.keys().collect();
        motel_names.sort();
        our_names.sort();
        assert_eq!(our_names, motel_names, "{route}{path}: fields");
        for (name, field) in our_fields {
            assert_shape(route, &format!("{path}.{name}"), &motel_fields[name], field);
        }
    }
    if let (Some(motel_items), Some(our_items)) = (motel.get("items"), ours.get("items")) {
        assert_shape(route, &format!("{path}[]"), motel_items, our_items);
    }
}

/// Each kept route answers with the fields and JSON types of Motel's own answers, recorded by
/// `collector-diff` into `tests/fixtures/motel`.
#[test]
fn every_route_answers_with_motels_fields_and_types() {
    let scratch = Scratch::new("shapes");
    let collector = Collector::start(&scratch.data(), &[]);
    send_corpus(&collector);
    for (fixture, query) in [
        ("services", "/api/services".to_owned()),
        ("traces", "/api/traces?lookback=1d&limit=100".to_owned()),
        ("trace", format!("/api/traces/{TREE}")),
        ("trace-orphans", format!("/api/traces/{ORPHANS}")),
        ("trace-spans", format!("/api/traces/{TREE}/spans")),
        ("trace-logs", format!("/api/traces/{TREE}/logs")),
        (
            "spans-search",
            format!("/api/spans/search?lookback=1d&limit=10000&traceId={TREE}"),
        ),
        ("logs", "/api/logs?lookback=1d&limit=500".to_owned()),
        (
            "traces-stats",
            "/api/traces/stats?groupBy=operation&agg=count&lookback=1h&limit=12".to_owned(),
        ),
        ("trace-missing", format!("/api/traces/{}", "0".repeat(32))),
    ] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("tests/fixtures/motel/{fixture}.json"));
        let motel: Value =
            serde_json::from_slice(&std::fs::read(&path).expect("fixture")).expect("fixture JSON");
        let (status, body) = collector.get(&query);
        assert_eq!(
            u64::from(status),
            motel["status"].as_u64().expect("status"),
            "{fixture}: {body}"
        );
        assert_shape(fixture, "", &motel["shape"], &shape_of(&body, ""));
    }
}

/// Page through a cursor-paged route to the end: the rows' ids, and each page's row count and
/// `truncated`.
fn pages(collector: &Collector, query: &str, id: &str) -> (Vec<String>, Vec<(usize, bool)>) {
    let (mut ids, mut shapes, mut cursor) = (Vec::new(), Vec::new(), None::<String>);
    for _ in 0..100 {
        let url = match &cursor {
            Some(cursor) => format!("{query}&cursor={cursor}"),
            None => query.to_owned(),
        };
        let (status, body) = collector.get(&url);
        assert_eq!(status, 200, "{url}: {body}");
        let data = body["data"].as_array().expect("data");
        ids.extend(
            data.iter()
                .map(|row| row[id].as_str().expect("id").to_owned()),
        );
        let truncated = body["meta"]["truncated"].as_bool().expect("truncated");
        shapes.push((data.len(), truncated));
        assert_eq!(body["meta"]["returned"].as_u64(), Some(data.len() as u64));
        if !truncated {
            return (ids, shapes);
        }
        cursor = Some(
            body["meta"]["nextCursor"]
                .as_str()
                .expect("a cursor on a truncated page")
                .to_owned(),
        );
    }
    panic!("{query} did not end within 100 pages");
}

/// `truncated` is true exactly when more rows exist, and cursors lose and repeat nothing when
/// rows share a timestamp at the page boundary: exactly one page, one page plus one, and pages of
/// traces that all start at once.
#[test]
fn cursors_are_exact_at_page_boundaries_and_truncated_means_more_rows() {
    use serde_json::json;
    let scratch = Scratch::new("cursors");
    let collector = Collector::start(&scratch.data(), &[]);
    let at = |count: usize, page: &str, same: bool| {
        let time = ago(40.0);
        otlp_logs(page, (0..count).map(|index| json!({
            "timeUnixNano": if same { time.clone() } else { ago(40.0 - index as f64 * 0.001) },
            "body": { "stringValue": format!("{page} {index}") },
        })).collect())
    };
    assert_eq!(collector.post("/v1/logs", &at(100, "exact", false)).0, 200);
    assert_eq!(collector.post("/v1/logs", &at(101, "plus", true)).0, 200);
    assert_eq!(collector.post("/v1/logs", &at(250, "many", true)).0, 200);
    let (ids, shape) = pages(
        &collector,
        "/api/logs?service=exact&lookback=1h&limit=100",
        "id",
    );
    assert_eq!(
        (ids.len(), shape),
        (100, vec![(100, false)]),
        "exactly one page"
    );
    let (ids, shape) = pages(
        &collector,
        "/api/logs?service=plus&lookback=1h&limit=100",
        "id",
    );
    assert_eq!(shape, vec![(100, true), (1, false)], "one page plus one");
    let unique: std::collections::BTreeSet<_> = ids.iter().collect();
    assert_eq!((ids.len(), unique.len()), (101, 101));
    let (ids, shape) = pages(
        &collector,
        "/api/logs?service=many&lookback=1h&limit=7",
        "id",
    );
    let unique: std::collections::BTreeSet<_> = ids.iter().collect();
    assert_eq!(
        (ids.len(), unique.len(), shape.len()),
        (250, 250, 36),
        "seven at a time over one timestamp"
    );
    // 45 traces that start at the same moment, 20 to a page.
    let start = ago(60.0);
    let spans = (0..45u64)
        .map(|index| json!({ "traceId": format!("{:032x}", 0xabc000 + index), "spanId": format!("{:016x}", index + 1),
                             "name": "shared.start", "startTimeUnixNano": start, "endTimeUnixNano": ago(59.0) }))
        .collect();
    assert_eq!(
        collector.post("/v1/traces", &otlp_spans("batch", spans)).0,
        200
    );
    let (ids, shape) = pages(
        &collector,
        "/api/traces?service=batch&lookback=1h&limit=20",
        "traceId",
    );
    let unique: std::collections::BTreeSet<_> = ids.iter().collect();
    assert_eq!(shape, vec![(20, true), (20, true), (5, false)]);
    assert_eq!(unique.len(), 45);
    // Motel's order: newest first, ties by trace id descending.
    let mut sorted = ids.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(ids, sorted);
    let (ids, _) = pages(
        &collector,
        "/api/traces?service=batch&lookback=1h&limit=45",
        "traceId",
    );
    assert_eq!(ids.len(), 45);
    let (_, shape) = pages(
        &collector,
        "/api/traces?service=batch&lookback=1h&limit=45",
        "traceId",
    );
    assert_eq!(shape, vec![(45, false)], "exactly one page of traces");
}

/// One trace of `spans` spans with `trace_export`'s 200-byte attribute, sent in exports of
/// 10,000.
fn send_large_trace(collector: &Collector, trace: &str, spans: u64) {
    for first in (0..spans).step_by(10_000) {
        let (status, body) = collector.post(
            "/v1/traces",
            &trace_export(trace, first, 10_000.min(spans - first)),
        );
        assert_eq!(status, 200, "{body}");
    }
}

/// Open a request for `path` and read only its head, leaving the body unread so the collector's
/// reader waits to send the rest. The stream, to read or drop later.
fn stall(collector: &Collector, path: &str) -> TcpStream {
    let Address::Tcp(port) = collector.address else {
        panic!("a TCP collector")
    };
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
    // A small receive buffer, so a large body fills it and the sender must wait.
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: collector\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .expect("send");
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).expect("a response starts");
    assert_eq!(&head[9..12], b"200");
    stream
}

/// The readers are bounded: with every reader held by a response its caller is not reading, a
/// query is refused with 503 and `Retry-After: 1`; a caller hanging up frees its reader at once;
/// the deadline cuts off a stalled response; and stopping ends within the shutdown budget.
#[test]
fn readers_are_bounded_freed_by_hanging_up_cut_off_at_their_deadline_and_stopped() {
    let _heavy = heavy();
    let scratch = Scratch::new("readers");
    let collector = Collector::start(&scratch.data(), &[]);
    let big = "0000000000000000000000000000b16b";
    send_large_trace(&collector, big, 100_000);
    let path = format!("/api/traces/{big}");
    let mut stalled: Vec<TcpStream> = (0..4).map(|_| stall(&collector, &path)).collect();
    let started = Instant::now();
    let Address::Tcp(port) = collector.address else {
        unreachable!()
    };
    let refused = {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
        stream
            .write_all(b"GET /api/services HTTP/1.1\r\nHost: c\r\nConnection: close\r\n\r\n")
            .expect("send");
        let mut response = Vec::new();
        stream.read_to_end(&mut response).expect("receive");
        String::from_utf8_lossy(&response).to_ascii_lowercase()
    };
    assert!(refused.starts_with("http/1.1 503"), "{refused}");
    assert!(refused.contains("retry-after: 1"), "{refused}");
    let (_, ingest) = collector.get("/api/ingest");
    assert_eq!(ingest["readers"]["refusedBusy"], 1, "{ingest}");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the refusal waited {:?}",
        started.elapsed()
    );
    // Hanging up frees a reader long before the 5-second deadline.
    drop(stalled.pop());
    drop(stalled.pop());
    let started = Instant::now();
    let (status, _) = collector.get("/api/services");
    assert_eq!(status, 200);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a freed reader took {:?}",
        started.elapsed()
    );
    // The two still stalled are cut off at their deadline: their bodies end incomplete.
    wait_for_ingest(&collector, Duration::from_secs(15), |ingest| {
        ingest["readers"]["cutOff"].as_u64() == Some(2)
    });
    for mut stream in stalled.drain(..) {
        let mut rest = Vec::new();
        let _ = stream.read_to_end(&mut rest);
        // `stall` read the first 12 bytes, "HTTP/1.1 200".
        let response = [b"HTTP/1.1 200".as_slice(), &rest].concat();
        let (_, _, body) = split_response(&response);
        assert!(
            dechunk(body).is_none(),
            "a stalled response was not cut off"
        );
    }
    // A full read of the same trace, streamed, returns every span.
    let (status, body) = collector.get(&path);
    assert_eq!(status, 200);
    assert_eq!(
        body["data"]["spans"].as_array().map(Vec::len),
        Some(100_000)
    );
    assert_eq!(body["data"]["spanCount"], 100_000);
    // Stopping with every reader held ends within the budget.
    let _held: Vec<TcpStream> = (0..4).map(|_| stall(&collector, &path)).collect();
    let (status, stderr, took) = collector.stop_within(Duration::from_secs(10));
    assert!(status.success(), "{stderr}");
    assert!(
        took < Duration::from_millis(2_900),
        "stopping took {took:?}"
    );
}

/// A query's answer, retrying a 503 after a second as a caller does (`Retry-After: 1`): the read
/// gate or a busy reader refuses a query rather than answering it in part.
fn answered(collector: &Collector, path: &str) -> (u16, Value) {
    for _ in 0..20 {
        let (status, body) = collector.get(path);
        if status != 503 {
            return (status, body);
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    panic!("{path} was refused 20 times");
}

/// A trace being evicted is answered as gone, never in part: while a 100,000-span trace is
/// deleted in steps, every read of it is the whole trace, from before eviction began, or 404,
/// and nothing lists a trace answered as gone.
#[test]
fn a_trace_being_evicted_is_never_answered_in_part() {
    let _heavy = heavy();
    let scratch = Scratch::new("evicting-reads");
    let big = "0000000000000000000000000000dead";
    {
        let collector = Collector::start(&scratch.data(), &[]);
        send_large_trace(&collector, big, 100_000);
        let (status, _, _) = collector.stop();
        assert!(status.success());
    }
    // One real retention step, through the library, before the collector starts: the trace is
    // part deleted and marked as being evicted. A write lock from outside then holds the
    // collector's own steps off while it starts and answers, so the reads below land in that
    // window by construction, however fast the host evicts.
    use executor_collector::{retention, store as library};
    let database = library::database_path(&scratch.data());
    let limits = retention::Limits {
        max_bytes: 4 << 20,
        retention_ms: 168 * 3_600_000,
    };
    {
        let mut connection = library::open(&database).expect("opens");
        retention::step(
            &mut connection,
            &limits,
            library::now_ms(),
            retention::STEP_ROWS,
        )
        .expect("a step");
        assert!(
            retention::evicting(&connection).expect("reads").is_some(),
            "the trace is not part deleted"
        );
    }
    let outside = Connection::open(&database).expect("opens");
    outside.execute_batch("BEGIN IMMEDIATE").expect("locks");
    let collector = Collector::start(&scratch.data(), &["--max-store-mb", "4"]);
    let (mut whole, mut gone_while_deleting) = (0, 0);
    for _ in 0..20 {
        let (status, _) = answered(&collector, &format!("/api/traces/{big}"));
        assert_eq!(status, 404, "a part-deleted trace was answered");
        let (_, spans) = answered(&collector, &format!("/api/traces/{big}/spans"));
        assert_eq!(spans["data"].as_array().map(Vec::len), Some(0));
        let (_, list) = answered(&collector, "/api/traces?lookback=1h&limit=100");
        assert!(
            !list.to_string().contains(big),
            "a list named a part-deleted trace"
        );
        let (_, probe) = answered(
            &collector,
            &format!("/api/spans/search?traceId={big}&lookback=1h&limit=1"),
        );
        assert_eq!(probe["data"].as_array().map(Vec::len), Some(0));
        gone_while_deleting += 1;
    }
    outside.execute_batch("COMMIT").expect("unlocks");
    drop(outside);
    let started = Instant::now();
    for round in 0.. {
        // Cheap reads first, many while the trace is being deleted: each sees all of it or none.
        for _ in 0..20 {
            let (_, probe) = answered(
                &collector,
                &format!("/api/spans/search?traceId={big}&lookback=1h&limit=1"),
            );
            let (list_status, list) = answered(&collector, "/api/traces?lookback=1h&limit=100");
            let list_raw = last_response();
            let (_, during) = collector.get("/api/ingest");
            let Some(rows) = list["data"].as_array() else {
                // What the collector logged explains an answer that is not a list.
                let (_, stderr, _) = collector.stop();
                panic!(
                    "the list answered {list_status}:\n{list_raw}\nthe status then: {during}\nthe collector's stderr:\n{stderr}"
                );
            };
            let listed = rows.iter().find(|trace| trace["traceId"] == big);
            if let Some(listed) = listed {
                assert_eq!(
                    listed["spanCount"], 100_000,
                    "the list showed part of the trace"
                );
            }
            let found = probe["data"].as_array().map(Vec::len).unwrap_or(0);
            if found == 0
                && during["evictions"]["spans"].as_u64() > Some(0)
                && during["store"]["maintenancePending"] == true
            {
                gone_while_deleting += 1;
            }
        }
        let (_, before) = collector.get("/api/ingest");
        let (status, body) = if round % 50 == 0 {
            answered(&collector, &format!("/api/traces/{big}"))
        } else {
            let (status, _) = answered(&collector, &format!("/api/traces/{big}/logs"));
            // The logs route answers 200 for any id; use the summary list to decide.
            let (_, list) = answered(&collector, "/api/traces?lookback=1h&limit=100");
            let listed = list.to_string().contains(big);
            assert_eq!(status, 200);
            (if listed { 200 } else { 404 }, Value::Null)
        };
        let (_, after) = collector.get("/api/ingest");
        match status {
            200 if body.is_null() => {}
            200 => {
                assert_eq!(
                    body["data"]["spans"].as_array().map(Vec::len),
                    Some(100_000),
                    "a read returned part of the trace"
                );
                assert_eq!(body["data"]["spanCount"], 100_000);
                whole += 1;
            }
            404 => {
                let (_, spans) = answered(&collector, &format!("/api/traces/{big}/spans"));
                assert_eq!(spans["data"].as_array().map(Vec::len), Some(0));
                let (_, list) = answered(&collector, "/api/traces?lookback=1h&limit=100");
                assert!(
                    !list.to_string().contains(big),
                    "a list named a trace answered as gone"
                );
                if before["evictions"]["spans"].as_u64() > Some(0)
                    && after["store"]["maintenancePending"] == true
                {
                    gone_while_deleting += 1;
                }
            }
            other => panic!("a read answered {other}: {body}"),
        }
        if status == 404 && after["store"]["maintenancePending"] == false {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "eviction did not finish: {after}"
        );
    }
    assert!(
        gone_while_deleting > 0,
        "no read landed while the trace was part deleted ({whole} whole reads)"
    );
}

/// Readers wait before exports are refused. Two callers read a large trace and leave each
/// response unread, so each read holds the write-ahead log until its 5-second deadline cuts it
/// off, one after another, while exports arrive. The writer cannot empty the log with them there,
/// so it holds new reads at the gate until they end: no export is refused, a read held too long
/// at the gate gets 503 with `Retry-After`, and the data directory stays within its bound
/// throughout.
#[test]
fn readers_wait_at_the_gate_so_exports_are_not_refused() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    let scratch = Scratch::new("gate");
    let collector = Arc::new(Collector::start_capped(
        &scratch.data(),
        &["--max-store-mb", "64"],
    ));
    let big = "000000000000000000000000000a9a7e";
    send_large_trace(&collector, big, 20_000);
    // The bound with its 10% allowances, the log's 32 MiB refusal size and admitted exports.
    let limit = 160 * 1024 * 1024;
    let stop = Arc::new(AtomicBool::new(false));
    let (stored, refused) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let mut workers = vec![{
        let (stop, stored, refused, address) = (
            stop.clone(),
            stored.clone(),
            refused.clone(),
            collector.address.clone(),
        );
        std::thread::spawn(move || {
            let mut ids = Ids(21 << 40);
            while !stop.load(Ordering::SeqCst) {
                match post_refusable(&address, &burst_export(&mut ids, 500, false)) {
                    Some(200) => stored.fetch_add(1, Ordering::SeqCst),
                    _ => refused.fetch_add(1, Ordering::SeqCst),
                };
                // Paced on purpose: a steady load, not as fast as possible.
                std::thread::sleep(Duration::from_millis(50));
            }
        })
    }];
    let unexpected = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let Address::Tcp(port) = collector.address else {
        panic!("a TCP collector")
    };
    for _ in 0..2 {
        let (stop, unexpected) = (stop.clone(), unexpected.clone());
        workers.push(std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
                stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
                stream
                    .write_all(
                        format!(
                            "GET /api/traces/{big} HTTP/1.1\r\nHost: c\r\nConnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .expect("send");
                let mut head = [0u8; 12];
                if stream.read_exact(&mut head).is_err() {
                    continue;
                }
                match &head[9..12] {
                    // Left unread until the collector cuts it off at its deadline.
                    b"200" => {
                        let mut rest = Vec::new();
                        let started = Instant::now();
                        while started.elapsed() < Duration::from_secs(7)
                            && !stop.load(Ordering::SeqCst)
                        {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        let _ = stream.read_to_end(&mut rest);
                    }
                    b"503" => {
                        let mut rest = Vec::new();
                        let _ = stream.read_to_end(&mut rest);
                        let text = String::from_utf8_lossy(&rest).to_ascii_lowercase();
                        if !text.contains("retry-after: 1") {
                            unexpected
                                .lock()
                                .expect("lock")
                                .push(format!("503 without Retry-After: {text}"));
                        }
                    }
                    other => unexpected
                        .lock()
                        .expect("lock")
                        .push(String::from_utf8_lossy(other).into_owned()),
                }
            }
        }));
    }
    let started = Instant::now();
    let mut breach = None;
    while started.elapsed() < Duration::from_secs(14) {
        let bytes = directory_bytes(&scratch.data());
        if bytes > limit {
            breach = Some(bytes);
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let (_, ingest) = collector.get("/api/ingest");
    stop.store(true, Ordering::SeqCst);
    for worker in workers {
        worker.join().expect("worker");
    }
    assert_eq!(breach, None, "the data directory passed {limit} bytes");
    assert!(
        ingest["store"]["gateClosings"].as_u64() > Some(0),
        "the readers never blocked a checkpoint, so the test did not test the gate: {ingest}"
    );
    assert_eq!(
        refused.load(Ordering::SeqCst),
        0,
        "exports were refused: {ingest}"
    );
    assert!(stored.load(Ordering::SeqCst) > 0);
    assert!(
        unexpected.lock().expect("lock").is_empty(),
        "{:?}",
        unexpected.lock().expect("lock")
    );
}

/// Every entry under `directory`: kind, size, bytes or link target, and modification time.
fn directory_snapshot(directory: &Path) -> std::collections::BTreeMap<String, String> {
    let mut entries = std::collections::BTreeMap::new();
    for entry in std::fs::read_dir(directory).expect("read_dir") {
        let path = entry.expect("entry").path();
        let metadata = std::fs::symlink_metadata(&path).expect("metadata");
        let modified = metadata
            .modified()
            .expect("mtime")
            .duration_since(std::time::UNIX_EPOCH)
            .expect("after the epoch")
            .as_nanos();
        let description = if metadata.is_file() {
            format!(
                "{} {modified} {:?}",
                metadata.len(),
                std::fs::read(&path).expect("read")
            )
        } else {
            format!("{:?} {modified}", metadata.file_type())
        };
        entries.insert(
            path.file_name()
                .expect("name")
                .to_string_lossy()
                .into_owned(),
            description,
        );
    }
    entries
}

/// The binary refuses a SQLite file of another application, with its write-ahead log and index
/// still holding committed rows, and changes nothing in the directory but adding its own empty
/// lock file.
#[test]
fn a_foreign_store_with_a_live_log_is_refused_and_left_exactly_as_it_was() {
    let scratch = Scratch::new("foreign-live");
    let source = Scratch::new("foreign-live-source");
    std::fs::create_dir_all(scratch.data()).expect("data");
    std::fs::create_dir_all(source.data()).expect("source");
    let holder = Connection::open(source.database()).expect("open");
    holder
        .execute_batch(
            "PRAGMA application_id = 4660; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             CREATE TABLE notes (body); INSERT INTO notes VALUES ('one');",
        )
        .expect("write");
    for suffix in ["", "-wal", "-shm"] {
        std::fs::copy(
            format!("{}{suffix}", source.database().display()),
            format!("{}{suffix}", scratch.database().display()),
        )
        .expect("copy");
    }
    drop(holder);
    let before = directory_snapshot(&scratch.data());
    let (status, stderr) = Collector::try_start(&scratch.data(), &[])
        .err()
        .expect("refused");
    assert!(!status.success());
    assert!(stderr.contains("not a telemetry store"), "{stderr}");
    let mut after = directory_snapshot(&scratch.data());
    let lock = after.remove("telemetry.lock").expect("its lock file");
    assert!(lock.starts_with("0 "), "the lock file is not empty: {lock}");
    assert_eq!(after, before, "the directory changed");
}

/// The status never reports maintenance finished while age eviction is owed: an idle writer looks
/// for expired rows only when it next wakes, so a status asked for after a trace or log has
/// expired, with nothing else to wake the writer, must say maintenance is pending until the rows
/// are gone. Restarted on a store whose one trace, or one log, expires 1.5 s later.
#[test]
fn the_status_counts_age_eviction_as_pending_from_the_moment_rows_expire() {
    const RETENTION_MS: i64 = 168 * 3_600_000;
    for (kind, path, body, column) in [
        (
            "traces",
            "/v1/traces",
            small_export(&"a".repeat(32), &"a".repeat(16)),
            "last_seen_ms",
        ),
        (
            "logs",
            "/v1/logs",
            br#"{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"svc"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1","body":{"stringValue":"x"}}]}]}]}"#.to_vec(),
            "seen_ms",
        ),
    ] {
        let scratch = Scratch::new(&format!("idle-age-{kind}"));
        let collector = Collector::start(&scratch.data(), &[]);
        assert_eq!(collector.post(path, &body).0, 200);
        let (status, _, _) = collector.stop();
        assert!(status.success());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as i64;
        // Expired from `seen + retention + 1`.
        let expires = now + 1_500;
        let connection = Connection::open(scratch.database()).expect("store");
        connection
            .execute(
                &format!("UPDATE {kind} SET {column} = ?1"),
                [expires - RETENTION_MS - 1],
            )
            .expect("age");
        drop(connection);
        let collector = Collector::start(&scratch.data(), &[]);
        let started = Instant::now();
        let mut asked_after_expiry = 0;
        loop {
            let asked = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_millis() as i64;
            let (_, ingest) = collector.get("/api/ingest");
            let answered = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_millis() as i64;
            let pending = ingest["store"]["maintenancePending"] == true;
            if asked > expires {
                asked_after_expiry += 1;
                if !pending {
                    // Finished: the expired rows must be gone.
                    let reader = Connection::open_with_flags(
                        scratch.database(),
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                    )
                    .expect("reader");
                    assert_eq!(
                        count(&reader, &format!("SELECT count(*) FROM {kind}")),
                        0,
                        "{kind}: the status said finished {} ms after expiry with the row still stored: {ingest}",
                        asked - expires
                    );
                    break;
                }
            } else if answered < expires {
                assert!(!pending, "{kind}: pending before anything expired: {ingest}");
            }
            assert!(
                started.elapsed() < Duration::from_secs(6),
                "{kind}: maintenance did not finish: {ingest}"
            );
            std::thread::sleep(Duration::from_millis(3));
        }
        assert!(asked_after_expiry > 0, "{kind}: never asked after expiry");
    }
}

/// An error in what start-up itself reads ends the start: a store whose `logs` table has its root
/// page zeroed fails retention's first look, so the collector exits 1 without a listening line,
/// rather than serving a store it cannot read.
#[test]
fn a_store_start_up_cannot_read_ends_the_start() {
    let scratch = Scratch::new("unreadable");
    let collector = Collector::start(&scratch.data(), &[]);
    let log = br#"{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"svc"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1","body":{"stringValue":"x"}}]}]}]}"#;
    assert_eq!(collector.post("/v1/logs", log).0, 200);
    let (status, _, _) = collector.stop();
    assert!(status.success());
    let (root, page_size) = {
        let connection = Connection::open(scratch.database()).expect("store");
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .expect("checkpoint");
        (
            count(
                &connection,
                "SELECT rootpage FROM sqlite_schema WHERE name = 'logs'",
            ),
            count(&connection, "PRAGMA page_size"),
        )
    };
    let mut bytes = std::fs::read(scratch.database()).expect("file");
    let at = ((root - 1) * page_size) as usize;
    bytes[at..at + page_size as usize].fill(0);
    std::fs::write(scratch.database(), &bytes).expect("zero the page");
    match Collector::try_start(&scratch.data(), &[]) {
        Ok(_) => panic!("the collector served a store it could not read"),
        Err((status, stderr)) => {
            assert_eq!(status.code(), Some(1), "{stderr}");
            assert!(stderr.contains("cannot read the store"), "{stderr}");
        }
    }
}

// --- Query answers: parameters, cursors and filters -------------------------------------------

/// Every query route, with a query string appended by `?` or `&`.
fn query_routes() -> Vec<String> {
    vec![
        "/api/services?".to_owned(),
        "/api/traces?".to_owned(),
        "/api/traces/stats?groupBy=service&agg=count&".to_owned(),
        format!("/api/traces/{TREE}?"),
        format!("/api/traces/{TREE}/spans?"),
        format!("/api/traces/{TREE}/logs?"),
        "/api/spans/search?".to_owned(),
        "/api/logs?".to_owned(),
        "/api/logs/search?".to_owned(),
    ]
}

/// One request sent as raw bytes; the status, or `None` when the connection ended unanswered.
fn raw_status(collector: &Collector, target: &[u8]) -> Option<u16> {
    let Address::Tcp(port) = collector.address else {
        panic!("a TCP collector")
    };
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
    let mut raw = b"GET ".to_vec();
    raw.extend_from_slice(target);
    raw.extend_from_slice(b" HTTP/1.1\r\nHost: c\r\nConnection: close\r\n\r\n");
    stream.write_all(&raw).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    if response.is_empty() {
        return None;
    }
    Some(received(&response).0)
}

/// No query string ends the process or fails a request: every one is answered 200, 400 or 404,
/// on every route, and the collector goes on storing exports. Non-ASCII, empty, huge, repeated,
/// control characters and broken percent-encoding, in every parameter.
#[test]
fn malformed_query_strings_are_answered_on_every_route_and_never_end_the_process() {
    let scratch = Scratch::new("malformed");
    let collector = Collector::start(&scratch.data(), &[]);
    send_corpus(&collector);
    let long = "x".repeat(6_000);
    let mut queries: Vec<Vec<u8>> = [
        "lookback=%C3%A9",
        "lookback=%C3%A9m",
        "lookback=1%C3%A9",
        "lookback=999999999999999999h",
        "lookback=999999999999999999999999m",
        "lookback=0d",
        "lookback=-5m",
        "lookback=1e9d",
        "lookback=1%E2%80%8Bm",
        "lookback=%00",
        "lookback=",
        "limit=%FF%FE",
        "limit=",
        "limit=1&limit=2",
        "limit=99999999999999999999999",
        "limit=-1",
        "limit=NaN",
        "cursor=%00%01",
        "cursor=garbage",
        "cursor=t2.",
        "cursor=t2.x.1.2.3",
        "cursor=l2.%C3%A9.1.2",
        "cursor=l2.0000000000000000.99999999999999999999.1",
        "service=%",
        "service=%C3",
        "%%%",
        "=&=&&",
        "a=%ZZ&b=%Z",
        "operation=%01%1F%7F",
        "body=%C3%28",
        "body=__",
        "operation=__",
        "attr.=x",
        "attr.%22%5D=1",
        "attr.a.b.c=%C3%A9",
        "traceId=zz",
        "traceId=%C3%A9",
        "spanId=%C3%A9",
        "severity=%C3%A9",
        "status=bogus",
        "minDurationMs=abc",
        "groupBy=%C3%A9&agg=count",
        "service=a&service=a",
    ]
    .iter()
    .map(|query| query.as_bytes().to_vec())
    .collect();
    queries.push(format!("operation={long}").into_bytes());
    queries.push(format!("body={long}").into_bytes());
    queries.push(format!("cursor={long}").into_bytes());
    // Raw bytes the client did not encode.
    queries.push(b"lookback=\xc3\xa9".to_vec());
    queries.push(b"body=\xff\xfe".to_vec());
    let mut answers = std::collections::BTreeMap::<u16, usize>::new();
    for route in query_routes() {
        for query in &queries {
            let mut target = route.as_bytes().to_vec();
            target.extend_from_slice(query);
            let status = raw_status(&collector, &target);
            let shown = String::from_utf8_lossy(&target).into_owned();
            let status = status.unwrap_or_else(|| panic!("{shown}: no answer"));
            assert!(
                matches!(status, 200 | 400 | 404),
                "{shown}: answered {status}"
            );
            *answers.entry(status).or_default() += 1;
        }
    }
    // The process is still up and still stores exports.
    assert_eq!(collector.get("/api/health").0, 200);
    assert_eq!(
        collector
            .post(
                "/v1/traces",
                &small_export(&"7".repeat(32), &"7".repeat(16))
            )
            .0,
        200
    );
    assert!(
        answers.get(&200).is_some_and(|count| *count > 100),
        "{answers:?}"
    );
    assert!(
        answers.get(&400).is_some_and(|count| *count > 50),
        "{answers:?}"
    );
    let (status, stderr, _) = collector.stop();
    assert!(status.success(), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
}

/// Motel's lookback: digits and a unit, the minutes clamped to 1 to 7 days however large the
/// number; anything else is the default hour.
#[test]
fn lookbacks_are_read_and_clamped_as_motel_read_them() {
    use serde_json::json;
    let scratch = Scratch::new("lookback");
    let collector = Collector::start(&scratch.data(), &[]);
    let span = |trace: &str, age: f64| {
        json!({ "traceId": trace, "spanId": "00f067aa0ba90201", "name": "old",
                "startTimeUnixNano": ago(age), "endTimeUnixNano": ago(age - 1.0) })
    };
    // One trace two days old, one two hours old.
    let body = otlp_spans(
        "clock",
        vec![
            span(&format!("{:032x}", 0xd1), 2.0 * 86_400.0),
            span(&format!("{:032x}", 0xd2), 2.0 * 3_600.0),
        ],
    );
    assert_eq!(collector.post("/v1/traces", &body).0, 200);
    for (lookback, meta, rows) in [
        ("999999999999999999h", "7d", 2),
        ("999999999999999999999999m", "7d", 2),
        ("8d", "7d", 2),
        ("3H", "3h", 1),
        ("%203h%20", "3h", 1),
        // ECMAScript's trim: U+FEFF is trimmed, U+0085 is not.
        ("%EF%BB%BF3h", "3h", 1),
        ("%C2%853h", "1h", 0),
        ("90m", "90m", 0),
        ("0m", "1h", 0),
        ("1.5h", "1h", 0),
        ("%C3%A9", "1h", 0),
        ("1%C3%A9", "1h", 0),
        ("2d", "2d", 1),
        ("3d", "3d", 2),
    ] {
        let (status, body) =
            collector.get(&format!("/api/traces?service=clock&lookback={lookback}"));
        assert_eq!(status, 200, "{lookback}");
        assert_eq!(body["meta"]["lookback"], meta, "{lookback}");
        assert_eq!(
            body["data"].as_array().map(Vec::len),
            Some(rows),
            "{lookback}: {body}"
        );
    }
}

/// A parameter Motel's route schema declared, given twice, is refused 400 with an empty body,
/// as Motel's schema refused it; an attribute filter given twice keeps its last value.
#[test]
fn a_declared_parameter_given_twice_is_refused() {
    let scratch = Scratch::new("repeated");
    let collector = Collector::start(&scratch.data(), &[]);
    send_corpus(&collector);
    for (route, parameter) in [
        ("/api/traces", "limit=1&limit=2"),
        ("/api/traces", "lookback=1m&lookback=1h"),
        ("/api/traces", "service=api&service=worker"),
        ("/api/traces", "service=api&service=api"),
        ("/api/traces", "cursor=a&cursor=b"),
        ("/api/traces/stats", "groupBy=service&agg=count&agg=count"),
        (
            "/api/traces/stats",
            "groupBy=service&agg=count&service=a&service=b",
        ),
        ("/api/spans/search", "operation=a&operation=b"),
        ("/api/spans/search", "traceId=a&traceId=b"),
        ("/api/logs", "body=a&body=b"),
        ("/api/logs", "severity=a&severity=a"),
        ("/api/logs/search", "spanId=a&spanId=b"),
        ("/api/logs/search", "service=a&service=b"),
    ] {
        let (status, body) = collector.get(&format!("{route}?{parameter}"));
        assert_eq!((status, body), (400, Value::Null), "{route}?{parameter}");
    }
    let (status, _) = collector.get(&format!("/api/traces/{TREE}/logs?limit=1&limit=2"));
    assert_eq!(status, 400);
    // The last value of an attribute filter wins, as in Motel.
    let (status, body) =
        collector.get("/api/spans/search?lookback=1d&attr.flag=false&attr.flag=true");
    assert_eq!(status, 200);
    assert_eq!(body["data"].as_array().map(Vec::len), Some(1), "{body}");
}

/// A cursor is a position in its list's order. One that does not decode, is of the other kind of
/// list, or has a number out of range is refused with 400 and a message, never read as page one; a
/// well-formed position is taken on any list of its kind; an empty one means no cursor.
#[test]
fn a_malformed_cursor_is_refused_and_a_well_formed_one_is_a_position() {
    let scratch = Scratch::new("cursor-shapes");
    let collector = Collector::start(&scratch.data(), &[]);
    send_corpus(&collector);
    let next = |path: &str| -> String {
        let (status, body) = collector.get(path);
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["meta"]["truncated"], true, "{body}");
        body["meta"]["nextCursor"]
            .as_str()
            .expect("cursor")
            .to_owned()
    };
    let traces = next("/api/traces?lookback=1d&limit=1");
    let logs = next("/api/logs?lookback=1d&limit=1");
    assert!(traces.starts_with("t3."), "{traces}");
    assert!(logs.starts_with("l3."), "{logs}");
    let malformed = [
        ("/api/traces", "garbage".to_owned()),
        ("/api/logs", "garbage".to_owned()),
        ("/api/traces", logs.clone()),
        ("/api/logs", traces.clone()),
        (&format!("/api/traces/{TREE}/logs"), traces.clone()),
        ("/api/traces", format!("{traces}x")),
        ("/api/traces", format!("{traces}.1")),
        ("/api/traces", "t3.123".to_owned()),
        ("/api/traces", format!("t3.-1.{}", "a".repeat(32))),
        (
            "/api/traces",
            format!("t3.99999999999999999999.{}", "a".repeat(32)),
        ),
        ("/api/traces", format!("t3.1.{}", "A".repeat(32))),
        ("/api/traces", format!("t3.1.{}", "a".repeat(31))),
        ("/api/logs", "l3.1.0".to_owned()),
        ("/api/logs", "l3.1.-5".to_owned()),
        ("/api/logs", "l3.1.1e3".to_owned()),
        ("/api/logs", "l3..1".to_owned()),
        ("/api/logs", logs.replace("l3.", "l2.")),
        ("/api/traces", traces.replace("t3.", "t2.")),
    ];
    // A log cursor cut short, each number just past the largest a position holds, and a time
    // before 1970, on every route that takes one.
    let tree_logs = format!("/api/traces/{TREE}/logs");
    let log_routes = ["/api/logs", "/api/logs/search", tree_logs.as_str()];
    let log_cursors = [
        "l3.1",
        "l3.9223372036854775808.1",
        "l3.1.9223372036854775808",
        "l3.-1.1",
    ];
    let malformed: Vec<(&str, String)> = malformed
        .iter()
        .map(|(route, cursor)| (*route, cursor.clone()))
        .chain(log_routes.iter().flat_map(|route| {
            log_cursors
                .iter()
                .map(move |cursor| (*route, (*cursor).to_owned()))
        }))
        .collect();
    for (route, cursor) in &malformed {
        let path = format!("{route}?cursor={cursor}");
        let (status, body) = collector.get(&path);
        assert_eq!(status, 400, "{path}: {body}");
        let error = body["error"].as_str().unwrap_or_default();
        assert!(error.contains("start the list again"), "{path}: {body}");
    }
    // A position is taken on any list of its kind, whatever list it came from.
    let elsewhere = {
        let (_, page) = collector.get("/api/traces?lookback=1d&limit=1&service=worker");
        page["meta"]["nextCursor"]
            .as_str()
            .expect("cursor")
            .to_owned()
    };
    for path in [
        format!("/api/traces?lookback=1d&limit=1&service=api&cursor={elsewhere}"),
        format!("/api/traces?lookback=1d&limit=1&cursor={traces}"),
        format!("/api/logs?lookback=1d&limit=1&service=worker&cursor={logs}"),
        format!("/api/traces/{TREE}/logs?cursor={logs}"),
        format!("/api/traces?cursor=t3.0.{}", "f".repeat(32)),
        format!("/api/logs?cursor=l3.{}.1", i64::MAX),
    ] {
        let (status, body) = collector.get(&path);
        assert_eq!(status, 200, "{path}: {body}");
    }
    // An empty cursor is no cursor: page one.
    let (_, first) = collector.get("/api/logs?lookback=1d&limit=2");
    let (status, empty) = collector.get("/api/logs?lookback=1d&limit=2&cursor=");
    assert_eq!((status, &empty["data"]), (200, &first["data"]));
}

/// A trace's place in the list is its start, which a later span can change. Each page continues
/// after its cursor in the list as it is then, so a trace that moves between two page requests
/// can be on two pages or on none, as the README says; no page errors or loops, and reading the
/// list again from the start finds every trace where it now is.
#[test]
fn a_trace_list_paged_while_traces_move_continues_and_a_new_read_finds_every_trace() {
    use serde_json::json;
    let scratch = Scratch::new("moving");
    let collector = Collector::start(&scratch.data(), &[]);
    let trace = |number: u64| format!("{:032x}", 0xe000 + number);
    let root = |number: u64, age: f64| {
        json!({ "traceId": trace(number), "spanId": format!("{:016x}", 0x100 + number), "name": "root",
                "startTimeUnixNano": ago(age), "endTimeUnixNano": ago(age - 0.5) })
    };
    let ids = |page: &Value| -> Vec<String> {
        page["data"]
            .as_array()
            .expect("data")
            .iter()
            .map(|row| row["traceId"].as_str().expect("id").to_owned())
            .collect()
    };
    // Five traces 10, 20, 30, 40 and 50 seconds old.
    let roots: Vec<Value> = (1..=5)
        .map(|number| root(number, 10.0 * number as f64))
        .collect();
    assert_eq!(
        collector.post("/v1/traces", &otlp_spans("moving", roots)).0,
        200
    );
    let list = "/api/traces?service=moving&lookback=1h&limit=2";
    let (_, page) = collector.get(list);
    let mut seen = ids(&page);
    assert_eq!(seen, vec![trace(1), trace(2)]);
    let mut cursor = page["meta"]["nextCursor"]
        .as_str()
        .expect("cursor")
        .to_owned();
    // Trace 1 gets an older child: it now starts 35 s ago, after the cursor.
    let child = json!({ "traceId": trace(1), "spanId": "00000000000000c1", "parentSpanId": format!("{:016x}", 0x101),
                        "name": "child", "startTimeUnixNano": ago(35.0), "endTimeUnixNano": ago(34.0) });
    assert_eq!(
        collector
            .post("/v1/traces", &otlp_spans("moving", vec![child]))
            .0,
        200
    );
    // Trace 4's root is sent again starting 15 s ago: it now starts before the cursor.
    assert_eq!(
        collector
            .post("/v1/traces", &otlp_spans("moving", vec![root(4, 15.0)]))
            .0,
        200
    );
    let mut pages = 1;
    loop {
        let (status, page) = collector.get(&format!("{list}&cursor={cursor}"));
        assert_eq!(status, 200, "{page}");
        let rows = ids(&page);
        let unique: std::collections::BTreeSet<_> = rows.iter().collect();
        assert_eq!(unique.len(), rows.len(), "a page repeated a trace: {page}");
        seen.extend(rows);
        pages += 1;
        assert!(pages <= 5, "the pages did not end: {seen:?}");
        match page["meta"]["nextCursor"].as_str() {
            Some(next) if page["meta"]["truncated"] == true => cursor = next.to_owned(),
            _ => break,
        }
    }
    // As documented: trace 1, moved past the cursor, is listed again; trace 4, moved before it,
    // is not listed on these pages.
    assert_eq!(seen, vec![trace(1), trace(2), trace(3), trace(1), trace(5)]);
    // Reading again from the start gives the current list, every trace once.
    let (_, all) = collector.get("/api/traces?service=moving&lookback=1h&limit=100");
    assert_eq!(
        ids(&all),
        vec![trace(4), trace(2), trace(3), trace(1), trace(5)]
    );
}

/// A trace's logs take the lookback as the other lists do, so `meta.lookback` states the window
/// applied, which the viewer shows.
#[test]
fn a_traces_logs_are_within_the_lookback_the_answer_states() {
    use serde_json::json;
    let scratch = Scratch::new("trace-logs");
    let collector = Collector::start(&scratch.data(), &[]);
    let trace = "0000000000000000000000000000f1a5";
    let logs = otlp_logs(
        "api",
        vec![
            json!({ "timeUnixNano": ago(2.0 * 3_600.0), "body": { "stringValue": "two hours ago" }, "traceId": trace }),
            json!({ "timeUnixNano": ago(60.0), "body": { "stringValue": "a minute ago" }, "traceId": trace }),
        ],
    );
    assert_eq!(collector.post("/v1/logs", &logs).0, 200);
    let bodies = |path: &str| -> (Vec<String>, Value) {
        let (status, body) = collector.get(path);
        assert_eq!(status, 200, "{body}");
        let rows = body["data"]
            .as_array()
            .expect("data")
            .iter()
            .map(|row| row["body"].as_str().expect("body").to_owned())
            .collect();
        (rows, body["meta"].clone())
    };
    let (rows, meta) = bodies(&format!("/api/traces/{trace}/logs?limit=200"));
    assert_eq!(rows, vec!["a minute ago"]);
    assert_eq!(
        (meta["lookback"].clone(), meta["truncated"].clone()),
        (Value::from("1h"), Value::from(false))
    );
    let (rows, meta) = bodies(&format!("/api/traces/{trace}/logs?lookback=3h"));
    assert_eq!(rows, vec!["a minute ago", "two hours ago"]);
    assert_eq!(meta["lookback"], "3h");
}

/// Every filter and parameter of every route selects exactly the rows it should: each alone,
/// some combined, with controls that must not match. Removing any one filter from the code makes
/// this fail.
#[test]
fn every_filter_selects_exactly_its_rows() {
    use serde_json::json;
    let scratch = Scratch::new("filters");
    let collector = Collector::start(&scratch.data(), &[]);
    let (cart, pay, old) = (
        "0000000000000000000000000000ca47",
        "000000000000000000000000000000a7",
        "000000000000000000000000000001d0",
    );
    let attribute =
        |key: &str, value: &str| json!({ "key": key, "value": { "stringValue": value } });
    let resource = |service: &str, environment: &str, spans: Vec<Value>| {
        serde_json::to_vec(&json!({ "resourceSpans": [{
            "resource": { "attributes": [attribute("service.name", service), attribute("env", environment)] },
            "scopeSpans": [{ "scope": { "name": "test" }, "spans": spans }],
        }] }))
        .expect("json")
    };
    let span = |trace: &str,
                id: &str,
                parent: Option<&str>,
                name: &str,
                age: f64,
                error: bool,
                attributes: Vec<Value>| {
        let mut span = json!({ "traceId": trace, "spanId": id, "name": name,
            "startTimeUnixNano": ago(age), "endTimeUnixNano": ago(age - 0.1), "attributes": attributes });
        if let Some(parent) = parent {
            span["parentSpanId"] = json!(parent);
        }
        if error {
            span["status"] = json!({ "code": 2 });
        }
        span
    };
    let shop = resource(
        "shop",
        "prod",
        vec![
            span(
                cart,
                "000000000000c001",
                None,
                "http.request GET /cart",
                30.0,
                false,
                vec![attribute("route", "/cart")],
            ),
            span(
                cart,
                "000000000000c002",
                Some("000000000000c001"),
                "db.query select",
                29.0,
                true,
                vec![attribute("db.system", "postgres")],
            ),
            span(
                cart,
                "000000000000c003",
                Some("000000000000c001"),
                "cache.get",
                28.0,
                false,
                vec![attribute("hit", "no")],
            ),
            span(
                old,
                "000000000000d001",
                None,
                "nightly.job",
                2.0 * 3_600.0,
                false,
                vec![],
            ),
        ],
    );
    let billing = resource(
        "billing",
        "dev",
        vec![
            span(
                pay,
                "000000000000a001",
                None,
                "http.request POST /pay",
                20.0,
                false,
                vec![attribute("route", "/pay")],
            ),
            span(
                pay,
                "000000000000a002",
                Some("000000000000a001"),
                "db.query insert",
                19.0,
                false,
                vec![attribute("db.system", "mysql")],
            ),
        ],
    );
    let ancient = resource(
        "ancient",
        "prod",
        vec![span(
            "00000000000000000000000000000a9e",
            "000000000000e001",
            None,
            "ancient",
            2.0 * 86_400.0,
            false,
            vec![],
        )],
    );
    for body in [shop, billing, ancient] {
        assert_eq!(collector.post("/v1/traces", &body).0, 200);
    }
    let log = |age: f64,
               severity: &str,
               body: &str,
               trace: Option<&str>,
               span: Option<&str>,
               attributes: Vec<Value>| {
        let mut log = json!({ "timeUnixNano": ago(age), "severityText": severity, "body": { "stringValue": body }, "attributes": attributes });
        if let Some(trace) = trace {
            log["traceId"] = json!(trace);
        }
        if let Some(span) = span {
            log["spanId"] = json!(span);
        }
        log
    };
    let logs = [
        otlp_logs(
            "shop",
            vec![
                log(
                    29.5,
                    "INFO",
                    "cart loaded",
                    Some(cart),
                    Some("000000000000c001"),
                    vec![],
                ),
                log(
                    28.5,
                    "WARN",
                    "cache miss for cart",
                    Some(cart),
                    Some("000000000000c003"),
                    vec![attribute("key", "k1")],
                ),
                log(
                    2.0 * 3_600.0,
                    "INFO",
                    "nightly cart sweep",
                    None,
                    None,
                    vec![],
                ),
            ],
        ),
        otlp_logs(
            "billing",
            vec![
                log(
                    19.5,
                    "ERROR",
                    "payment declined card_ending=1234",
                    Some(pay),
                    Some("000000000000a002"),
                    vec![attribute("customer.tier", "gold")],
                ),
                log(
                    18.5,
                    "info",
                    "charge settled",
                    Some(pay),
                    None,
                    vec![attribute("customer.tier", "silver")],
                ),
            ],
        ),
        otlp_logs(
            "logsonly",
            vec![log(10.0, "DEBUG", "heartbeat", None, None, vec![])],
        ),
    ];
    for body in logs {
        assert_eq!(collector.post("/v1/logs", &body).0, 200);
    }
    // Sorted values of `field` in each row of `path`'s data.
    let values = |path: &str, field: &dyn Fn(&Value) -> String| -> Vec<String> {
        let (status, body) = collector.get(path);
        assert_eq!(status, 200, "{path}: {body}");
        let mut found: Vec<String> = body["data"]
            .as_array()
            .expect("data")
            .iter()
            .map(field)
            .collect();
        found.sort();
        found
    };
    let operation = |row: &Value| {
        row["span"]["operationName"]
            .as_str()
            .expect("name")
            .to_owned()
    };
    let spans = |query: &str| values(&format!("/api/spans/search?{query}"), &operation);
    let names = |list: &[&str]| -> Vec<String> {
        let mut list: Vec<String> = list.iter().map(|name| (*name).to_owned()).collect();
        list.sort();
        list
    };
    let all_recent = [
        "http.request GET /cart",
        "db.query select",
        "cache.get",
        "http.request POST /pay",
        "db.query insert",
    ];
    assert_eq!(spans(""), names(&all_recent));
    assert_eq!(
        spans("service=shop"),
        names(&["http.request GET /cart", "db.query select", "cache.get"])
    );
    assert_eq!(
        spans("service=billing"),
        names(&["http.request POST /pay", "db.query insert"])
    );
    assert_eq!(spans("service=nobody"), names(&[]));
    assert_eq!(
        spans(&format!("traceId={pay}")),
        names(&["http.request POST /pay", "db.query insert"])
    );
    assert_eq!(spans(&format!("traceId={}", "f".repeat(32))), names(&[]));
    assert_eq!(
        spans("operation=db"),
        names(&["db.query select", "db.query insert"])
    );
    assert_eq!(
        spans("operation=query%20select"),
        names(&["db.query select"])
    );
    assert_eq!(
        spans("operation=http_request"),
        names(&["http.request GET /cart", "http.request POST /pay"])
    );
    assert_eq!(
        spans("operation=request_get"),
        names(&["http.request GET /cart"])
    );
    assert_eq!(spans("operation=uery"), names(&[]));
    assert_eq!(spans("operation=__"), names(&[]));
    assert_eq!(
        spans("operation=."),
        names(&[
            "http.request GET /cart",
            "db.query select",
            "cache.get",
            "http.request POST /pay",
            "db.query insert"
        ])
    );
    assert_eq!(
        spans("operation=%2F"),
        names(&["http.request GET /cart", "http.request POST /pay"])
    );
    assert_eq!(
        spans("attr.db.system=postgres"),
        names(&["db.query select"])
    );
    assert_eq!(
        spans("attr.route=%2Fpay"),
        names(&["http.request POST /pay"])
    );
    assert_eq!(
        spans("attr.env=prod"),
        names(&["http.request GET /cart", "db.query select", "cache.get"])
    );
    assert_eq!(spans("attr.env=prod&attr.hit=no"), names(&["cache.get"]));
    assert_eq!(
        spans("service=shop&operation=db"),
        names(&["db.query select"])
    );
    assert_eq!(spans("service=billing&operation=select"), names(&[]));
    assert_eq!(spans("lookback=3h&service=shop").len(), 4);
    let (_, limited) = collector.get("/api/spans/search?limit=2");
    assert_eq!(limited["data"].as_array().map(Vec::len), Some(2));
    assert_eq!(
        (
            limited["meta"]["truncated"].clone(),
            limited["meta"]["limit"].clone()
        ),
        (json!(true), json!(2))
    );

    let trace_ids = |query: &str| {
        values(&format!("/api/traces?{query}"), &|row: &Value| {
            row["traceId"].as_str().expect("id").to_owned()
        })
    };
    let ids = |list: &[&str]| -> Vec<String> {
        let mut list: Vec<String> = list.iter().map(|id| (*id).to_owned()).collect();
        list.sort();
        list
    };
    assert_eq!(trace_ids(""), ids(&[cart, pay]));
    assert_eq!(trace_ids("service=shop"), ids(&[cart]));
    assert_eq!(trace_ids("service=shop&lookback=3h"), ids(&[cart, old]));
    assert_eq!(
        trace_ids("lookback=3d"),
        ids(&[cart, pay, old, "00000000000000000000000000000a9e"])
    );
    assert_eq!(trace_ids("limit=1").len(), 1);

    let groups = |query: &str| {
        values(
            &format!("/api/traces/stats?agg=count&{query}"),
            &|row: &Value| format!("{}={}", row["group"].as_str().expect("group"), row["count"]),
        )
    };
    assert_eq!(groups("groupBy=service"), vec!["billing=1", "shop=1"]);
    assert_eq!(
        groups("groupBy=service&lookback=3h"),
        vec!["billing=1", "shop=2"]
    );
    assert_eq!(groups("groupBy=service&service=shop"), vec!["shop=1"]);
    assert_eq!(
        groups("groupBy=operation"),
        vec!["http.request GET /cart=1", "http.request POST /pay=1"]
    );
    assert_eq!(groups("groupBy=status"), vec!["error=1", "ok=1"]);
    assert_eq!(groups("groupBy=status&lookback=3h&limit=1"), vec!["ok=2"]);

    let body = |row: &Value| row["body"].as_str().expect("body").to_owned();
    let logs = |query: &str| values(&format!("/api/logs?{query}"), &body);
    let all_logs = [
        "cart loaded",
        "cache miss for cart",
        "payment declined card_ending=1234",
        "charge settled",
        "heartbeat",
    ];
    assert_eq!(logs(""), names(&all_logs));
    assert_eq!(values("/api/logs/search?", &body), names(&all_logs));
    assert_eq!(
        logs("service=shop"),
        names(&["cart loaded", "cache miss for cart"])
    );
    assert_eq!(
        logs("service=shop&lookback=3h"),
        names(&["cart loaded", "cache miss for cart", "nightly cart sweep"])
    );
    assert_eq!(
        logs("severity=error"),
        names(&["payment declined card_ending=1234"])
    );
    assert_eq!(
        logs("severity=INFO"),
        names(&["cart loaded", "charge settled"])
    );
    assert_eq!(
        logs(&format!("traceId={cart}")),
        names(&["cart loaded", "cache miss for cart"])
    );
    assert_eq!(
        logs("spanId=000000000000a002"),
        names(&["payment declined card_ending=1234"])
    );
    assert_eq!(
        logs("body=cart"),
        names(&["cart loaded", "cache miss for cart"])
    );
    assert_eq!(
        logs("body=card"),
        names(&["payment declined card_ending=1234"])
    );
    assert_eq!(
        logs("body=card_end"),
        names(&["payment declined card_ending=1234"])
    );
    assert_eq!(logs("body=ending_card"), names(&[]));
    assert_eq!(logs("body=miss%20cart"), names(&["cache miss for cart"]));
    assert_eq!(
        logs("body=%3D"),
        names(&["payment declined card_ending=1234"])
    );
    assert_eq!(
        logs("attr.customer.tier=gold"),
        names(&["payment declined card_ending=1234"])
    );
    assert_eq!(
        logs("attr.key=k1&service=shop"),
        names(&["cache miss for cart"])
    );
    assert_eq!(
        logs("service=billing&body=settled&severity=info"),
        names(&["charge settled"])
    );
    assert_eq!(logs("limit=2").len(), 2);
    let trace_logs = |query: &str| values(&format!("/api/traces/{cart}/logs?{query}"), &body);
    assert_eq!(
        trace_logs(""),
        names(&["cart loaded", "cache miss for cart"])
    );
    assert_eq!(trace_logs("limit=1").len(), 1);
    assert_eq!(
        trace_logs("lookback=1m"),
        names(&["cart loaded", "cache miss for cart"])
    );
    assert_eq!(
        values(&format!("/api/traces/{pay}/logs?"), &body),
        names(&["payment declined card_ending=1234", "charge settled"])
    );

    let services = values("/api/services", &|row: &Value| {
        row.as_str().expect("name").to_owned()
    });
    assert_eq!(services, vec!["billing", "logsonly", "shop"]);
}

// --- Readers: deadlines, queued responses, chunks, memory and the gate ------------------------

/// Open a request for `path` and return the stream unread.
fn open_request(collector: &Collector, path: &str) -> TcpStream {
    let Address::Tcp(port) = collector.address else {
        panic!("a TCP collector")
    };
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: c\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .expect("send");
    stream
}

/// Read a stream to its end: the bytes, and when it ended.
fn read_all(mut stream: TcpStream) -> (Vec<u8>, Instant) {
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    (response, Instant::now())
}

/// Matching an operation or a body is linear in the text (a body of 7.5 MB, and as many tokens in
/// span names of at most 4 KiB), and ends at the query's deadline, when the caller hangs up
/// before the response starts, and when the collector stops; the deadline even inside the one
/// 7.5 MB body that SQLite has long finished reading.
#[test]
fn text_matching_ends_at_the_deadline_and_when_the_caller_or_the_collector_goes() {
    let _heavy = heavy();
    use serde_json::json;
    let scratch = Scratch::new("matching");
    let collector = Collector::start(&scratch.data(), &[]);
    let text = "aa ".repeat(2_500_000);
    let log = otlp_logs(
        "words",
        vec![json!({ "timeUnixNano": ago(10.0), "body": { "stringValue": text } })],
    );
    assert_eq!(collector.post("/v1/logs", &log).0, 200);
    // The same 2,500,000 tokens in span names, which are at most 4 KiB: 1,876 spans of 1,333.
    let name = "aa ".repeat(1_333);
    for first in (0..1_876u64).step_by(469) {
        let spans: Vec<Value> = (first..first + 469)
            .map(|number| {
                json!({ "traceId": format!("{:032x}", 0xa0a0_0000 + number),
                "spanId": "000000000000a0a0", "name": name, "startTimeUnixNano": ago(10.0),
                "endTimeUnixNano": ago(9.0) })
            })
            .collect();
        assert_eq!(
            collector.post("/v1/traces", &otlp_spans("words", spans)).0,
            200
        );
    }
    // One word of 1,801 tokens, which a comparison restarted at every token made quadratic: it
    // took 11 s. Linear, it is a pass over the text.
    let word = format!("{}zz", "aa_".repeat(1_800));
    let started = Instant::now();
    let (status, body) = collector.get(&format!("/api/logs?body={word}"));
    assert_eq!(
        (status, body["data"].as_array().map(Vec::len)),
        (200, Some(0))
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "took {:?}",
        started.elapsed()
    );
    let started = Instant::now();
    let (status, body) = collector.get(&format!("/api/spans/search?operation={word}"));
    assert_eq!(
        (status, body["data"].as_array().map(Vec::len)),
        (200, Some(0))
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "operation matching took {:?}",
        started.elapsed()
    );
    // 2,000 words, each a pass over 2,500,000 tokens: more than 5 s of work, cut off at 5 s.
    let words: Vec<String> = (0..2_000).map(|number| format!("w{number:05}")).collect();
    let words = words.join("%20");
    let started = Instant::now();
    let (response, ended) = read_all(open_request(&collector, &format!("/api/logs?body={words}")));
    let took = ended - started;
    assert!(
        took < Duration::from_millis(5_800),
        "the response ended after {took:?}"
    );
    let (status, _, body) = split_response(&response);
    assert_eq!(status, 200);
    assert!(dechunk(body).is_none(), "the answer was not cut off");
    wait_for_ingest(&collector, Duration::from_secs(2), |ingest| {
        ingest["readers"]["cutOff"] == 1 && ingest["readers"]["busy"] == 0
    });
    // A caller that hangs up before the response starts frees its reader at once: span search
    // matches every span before it answers.
    let stream = open_request(&collector, &format!("/api/spans/search?operation={words}"));
    wait_for_ingest(&collector, Duration::from_secs(2), |ingest| {
        ingest["readers"]["busy"] == 1
    });
    // On purpose: let the query run well into its match before the caller hangs up.
    std::thread::sleep(Duration::from_millis(300));
    drop(stream);
    let dropped = Instant::now();
    wait_for_ingest(&collector, Duration::from_secs(4), |ingest| {
        ingest["readers"]["busy"] == 0
    });
    assert!(
        dropped.elapsed() < Duration::from_millis(1_500),
        "freed after {:?}",
        dropped.elapsed()
    );
    // Stopping ends a match in progress within the shutdown budget.
    let _running = open_request(&collector, &format!("/api/spans/search?operation={words}"));
    wait_for_ingest(&collector, Duration::from_secs(2), |ingest| {
        ingest["readers"]["busy"] == 1
    });
    let (status, stderr, took) = collector.stop_within(Duration::from_secs(10));
    assert!(status.success(), "{stderr}");
    assert!(
        took < Duration::from_millis(2_900),
        "stopping took {took:?}"
    );
}

/// Five spans sharing one resource of about 1 MiB: a trace answer of about 5 MB, small enough
/// that the query has queued all of it while the caller has read nothing.
fn send_heavy_trace(collector: &Collector, trace: &str) {
    use serde_json::json;
    let large = "r".repeat(1 << 20);
    let spans: Vec<Value> = (0..5u64)
        .map(|number| json!({ "traceId": trace, "spanId": format!("{:016x}", number + 1), "name": "heavy",
            "startTimeUnixNano": ago(20.0 - number as f64), "endTimeUnixNano": ago(19.0 - number as f64) }))
        .collect();
    let body = serde_json::to_vec(&json!({ "resourceSpans": [{
        "resource": { "attributes": [
            { "key": "service.name", "value": { "stringValue": "heavy" } },
            { "key": "large", "value": { "stringValue": large } },
        ] },
        "scopeSpans": [{ "spans": spans }],
    }] }))
    .expect("json");
    assert_eq!(collector.post("/v1/traces", &body).0, 200);
}

/// A response whose query has finished still holds its reader permit until it has left the
/// collector, and is ended at its deadline. Over a Unix socket, whose buffers are about 200 KB,
/// an answer of about 600 KB is all queued once the query ends, most of it in the collector:
/// twelve callers that read only the status line get four answers, the other eight 503 within a
/// second, and each answer's connection ends by its deadline with its body unsent.
#[test]
fn a_response_holds_its_reader_until_it_has_left_and_ends_at_its_deadline() {
    use serde_json::json;
    let scratch = Scratch::new("queued");
    let socket = scratch.0.join("collector.sock");
    let listen = format!("unix:{}", socket.display());
    let collector = Collector::start(&scratch.data(), &["--listen", &listen]);
    let trace = "00000000000000000000000000000e5e";
    let body = serde_json::to_vec(&json!({ "resourceSpans": [{
        "resource": { "attributes": [
            { "key": "service.name", "value": { "stringValue": "queued" } },
            { "key": "large", "value": { "stringValue": "q".repeat(600 * 1024) } },
        ] },
        "scopeSpans": [{ "spans": [{ "traceId": trace, "spanId": "0000000000000001", "name": "queued",
            "startTimeUnixNano": ago(20.0), "endTimeUnixNano": ago(19.0) }] }],
    }] }))
    .expect("json");
    assert_eq!(collector.post("/v1/traces", &body).0, 200);
    let request =
        format!("GET /api/traces/{trace} HTTP/1.1\r\nHost: c\r\nConnection: close\r\n\r\n");
    // Per caller: its status, when it came, and for an answer whether it came whole and when its
    // connection ended.
    type Caller = std::thread::JoinHandle<(u16, Duration, Option<(bool, Duration)>)>;
    let callers: Vec<Caller> = (0..12)
        .map(|_| {
            let (socket, request) = (socket.clone(), request.clone());
            std::thread::spawn(move || {
                let started = Instant::now();
                let mut stream = UnixStream::connect(&socket).expect("connect");
                stream.set_read_timeout(Some(IO_LIMIT)).expect("timeout");
                stream.write_all(request.as_bytes()).expect("send");
                let mut head = [0u8; 12];
                stream.read_exact(&mut head).expect("a status line");
                let status: u16 = std::str::from_utf8(&head[9..12])
                    .expect("status")
                    .parse()
                    .expect("status");
                let answered = started.elapsed();
                if status != 200 {
                    return (status, answered, None);
                }
                // Read nothing more until the collector ends the connection.
                std::thread::sleep(Duration::from_millis(5_600));
                let mut rest = Vec::new();
                let _ = stream.read_to_end(&mut rest);
                let ended = started.elapsed();
                let response = [head.as_slice(), &rest].concat();
                let (_, _, body) = split_response(&response);
                (status, answered, Some((dechunk(body).is_some(), ended)))
            })
        })
        .collect();
    let (mut answered, mut refused) = (0, 0);
    for caller in callers {
        match caller.join().expect("caller") {
            (200, _, Some((whole, ended))) => {
                answered += 1;
                assert!(!whole, "an answer left unread was sent whole");
                assert!(
                    ended < Duration::from_millis(6_500),
                    "a connection lasted {ended:?}"
                );
            }
            (503, at, None) => {
                refused += 1;
                assert!(at < Duration::from_millis(1_500), "refused after {at:?}");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!((answered, refused), (4, 8));
    let (_, ingest) = collector.get("/api/ingest");
    assert_eq!(ingest["readers"]["busy"], 0, "{ingest}");
    assert_eq!(ingest["readers"]["cutOff"], 4, "{ingest}");
    assert_eq!(ingest["readers"]["refusedBusy"], 8, "{ingest}");
}

/// A response is sent in chunks of at most 64 KiB, cut inside a value larger than that.
#[test]
fn responses_are_sent_in_chunks_of_at_most_64_kib() {
    let scratch = Scratch::new("chunks");
    let collector = Collector::start(&scratch.data(), &[]);
    let trace = "00000000000000000000000000000c4c";
    send_heavy_trace(&collector, trace);
    let (response, _) = read_all(open_request(&collector, &format!("/api/traces/{trace}")));
    let (status, _, mut body) = split_response(&response);
    assert_eq!(status, 200);
    let mut sizes = Vec::new();
    loop {
        let line = body
            .windows(2)
            .position(|window| window == b"\r\n")
            .expect("a chunk size");
        let size =
            usize::from_str_radix(std::str::from_utf8(&body[..line]).expect("hex").trim(), 16)
                .expect("hex");
        if size == 0 {
            break;
        }
        sizes.push(size);
        body = &body[line + 2 + size + 2..];
    }
    let total: usize = sizes.iter().sum();
    assert!(total > 5 << 20, "{total} bytes");
    assert_eq!(sizes.iter().max(), Some(&65_536), "{sizes:?}");
    // Every chunk but the last is full.
    assert!(
        sizes[..sizes.len() - 1].iter().all(|size| *size == 65_536),
        "{sizes:?}"
    );
}

/// Answers over many large resources hold one resource at a time, not every one they read, and
/// the memory they used is returned once they end: four slow callers of a list of spans with a
/// different 1 MiB resource each.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn answers_over_large_resources_stay_small_and_return_their_memory() {
    let _heavy = heavy();
    use serde_json::json;
    let scratch = Scratch::new("resources");
    let collector = Collector::start(&scratch.data(), &[]);
    for export in 0..4u64 {
        let groups: Vec<Value> = (0..8u64)
            .map(|number| {
                let index = export * 8 + number;
                json!({
                    "resource": { "attributes": [
                        { "key": "service.name", "value": { "stringValue": "wide" } },
                        { "key": "large", "value": { "stringValue": format!("{index:04}{}", "r".repeat(1 << 20)) } },
                    ] },
                    "scopeSpans": [{ "spans": [{ "traceId": format!("{:032x}", 0xf000 + index), "spanId": format!("{:016x}", index + 1),
                        "name": "wide", "startTimeUnixNano": ago(30.0 - index as f64 * 0.1), "endTimeUnixNano": ago(29.0) }] }],
                })
            })
            .collect();
        let body = serde_json::to_vec(&json!({ "resourceSpans": groups })).expect("json");
        assert_eq!(collector.post("/v1/traces", &body).0, 200);
    }
    let baseline = settled_resident_kib(collector.pid());
    // Each caller reads 16 MiB of its 33 MB answer, then stops reading.
    let readers: Vec<std::thread::JoinHandle<()>> = (0..4)
        .map(|_| {
            let mut stream = open_request(&collector, "/api/spans/search?service=wide&limit=500");
            std::thread::spawn(move || {
                let mut read = 0usize;
                let mut buffer = vec![0u8; 1 << 16];
                while read < 16 << 20 {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => return,
                        Ok(count) => read += count,
                    }
                }
                std::thread::sleep(Duration::from_secs(6));
            })
        })
        .collect();
    let started = Instant::now();
    let mut peak = baseline;
    while started.elapsed() < Duration::from_secs(5) {
        peak = peak.max(resident_kib(collector.pid()));
        std::thread::sleep(Duration::from_millis(20));
    }
    for reader in readers {
        reader.join().expect("reader");
    }
    wait_for_ingest(&collector, Duration::from_secs(3), |ingest| {
        ingest["readers"]["busy"] == 0
    });
    let after = settled_resident_kib(collector.pid());
    eprintln!("resident: {baseline} KiB before, {peak} KiB at most, {after} KiB after");
    // Each answer holds its current row (its 1 MiB resource decoded, and the row's copy of it),
    // its chunks and the cache's 256 KiB; four of them well under 48 MiB. Keeping every
    // resource an answer read was 32 MiB of text each.
    assert!(
        peak - baseline < 48 << 10,
        "{peak} KiB at most, from {baseline} KiB"
    );
    assert!(
        after < baseline + (16 << 10),
        "{after} KiB after, from {baseline} KiB"
    );
}

/// The read gate's every transition, with a reader outside the collector holding the log: it
/// closes past 8 MiB, a query waiting at it is refused at `GATE_WAIT`, it gives up after
/// `GATE_MOST`, rests `GATE_REST` while the log stays held, closes again, and once the outside
/// reader ends it opens and every waiting query is answered. Exports are refused only past a
/// sixteenth of the bound.
#[test]
fn the_read_gate_closes_refuses_gives_up_rests_and_wakes_its_waiters() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    let scratch = Scratch::new("gate-states");
    let collector = Arc::new(Collector::start_capped(
        &scratch.data(),
        &["--max-store-mb", "1024"],
    ));
    assert_eq!(
        collector
            .post(
                "/v1/traces",
                &small_export(&"1".repeat(32), &"1".repeat(16))
            )
            .0,
        200
    );
    let outside = Connection::open_with_flags(
        scratch.database(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("outside reader");
    outside.execute_batch("BEGIN").expect("begin");
    let _: i64 = outside
        .query_row("SELECT count(*) FROM spans", [], |row| row.get(0))
        .expect("read");
    // Exports as fast as they are taken; the log at the first refusal.
    let stop = Arc::new(AtomicBool::new(false));
    let first_refusal = Arc::new(std::sync::Mutex::new(None::<u64>));
    let sender = {
        let (stop, first_refusal, address, data) = (
            stop.clone(),
            first_refusal.clone(),
            collector.address.clone(),
            scratch.data(),
        );
        std::thread::spawn(move || {
            let mut ids = Ids(31 << 40);
            while !stop.load(Ordering::SeqCst) {
                let status = post_refusable(&address, &burst_export(&mut ids, 500, false));
                if status == Some(429) {
                    let mut first = first_refusal.lock().expect("lock");
                    if first.is_none() {
                        *first = std::fs::metadata(data.join("telemetry.sqlite-wal"))
                            .ok()
                            .map(|meta| meta.len());
                    }
                    drop(first);
                    // Back off after a refusal, as a sender does.
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        })
    };
    let ingest = wait_for_ingest(&collector, Duration::from_secs(30), |ingest| {
        ingest["store"]["gateClosed"] == true
    });
    let closed = Instant::now();
    assert_eq!(ingest["store"]["walRefuseBytes"], 64 << 20, "{ingest}");
    // A query at the closed gate waits `GATE_WAIT`, 2 s, then is refused.
    let waited = Instant::now();
    let refusal = {
        let (response, _) = read_all(open_request(&collector, "/api/services"));
        String::from_utf8_lossy(&response).to_ascii_lowercase()
    };
    let waited = waited.elapsed();
    assert!(
        refusal.starts_with("http/1.1 503") && refusal.contains("retry-after: 1"),
        "{refusal}"
    );
    assert!(
        waited > Duration::from_millis(1_900) && waited < Duration::from_millis(2_600),
        "refused after {waited:?}"
    );
    // The outside reader holds the log, so the gate gives up `GATE_MOST`, 6 s, after closing.
    let ingest = wait_for_ingest(&collector, Duration::from_secs(10), |ingest| {
        ingest["store"]["gateClosed"] == false
    });
    let opened = Instant::now();
    let gave_up = opened - closed;
    assert!(
        gave_up > Duration::from_millis(5_500) && gave_up < Duration::from_millis(7_000),
        "gave up after {gave_up:?}"
    );
    let closings = ingest["store"]["gateClosings"].clone();
    assert_eq!(ingest["readers"]["refusedGate"], 1, "{ingest}");
    // It rests 30 s: open, though the log is still held and past 8 MiB.
    while opened.elapsed() < Duration::from_secs(28) {
        let (_, ingest) = collector.get("/api/ingest");
        assert_eq!(
            ingest["store"]["gateClosed"],
            false,
            "closed during its rest after {:?}: {ingest}",
            opened.elapsed()
        );
        assert_eq!(ingest["store"]["gateClosings"], closings);
        assert!(
            ingest["store"]["walBytes"].as_u64() > Some(8 << 20),
            "{ingest}"
        );
        std::thread::sleep(Duration::from_millis(250));
    }
    let ingest = wait_for_ingest(&collector, Duration::from_secs(5), |ingest| {
        ingest["store"]["gateClosed"] == true
    });
    let rested = opened.elapsed();
    assert!(
        rested > Duration::from_secs(29) && rested < Duration::from_millis(31_500),
        "closed again after {rested:?}"
    );
    assert!(
        ingest["store"]["gateClosings"].as_u64() > closings.as_u64(),
        "{ingest}"
    );
    // Exports were refused only past 64 MiB, a sixteenth of the bound, not 32 MiB.
    let first = first_refusal
        .lock()
        .expect("lock")
        .expect("exports were refused");
    assert!(
        first > 64 << 20,
        "the first refusal came at a {first}-byte log"
    );
    // Callers waiting at the gate are answered as soon as the outside reader ends.
    let waiting: Vec<std::thread::JoinHandle<(u16, Instant)>> = (0..20)
        .map(|_| {
            let stream = open_request(&collector, "/api/services");
            std::thread::spawn(move || {
                let (response, ended) = read_all(stream);
                (split_response(&response).0, ended)
            })
        })
        .collect();
    // On purpose: no count of callers waiting at the gate is visible; give all twenty time to
    // reach it before the outside reader ends.
    std::thread::sleep(Duration::from_millis(300));
    outside
        .execute_batch("COMMIT")
        .expect("end the outside read");
    let released = Instant::now();
    for caller in waiting {
        let (status, ended) = caller.join().expect("caller");
        assert_eq!(status, 200);
        assert!(
            ended - released < Duration::from_millis(1_000),
            "answered {:?} after",
            ended - released
        );
    }
    stop.store(true, Ordering::SeqCst);
    sender.join().expect("sender");
    let (_, ingest) = collector.get("/api/ingest");
    assert_eq!(ingest["readers"]["refusedGate"], 1, "{ingest}");
}

/// While the read gate is closed, a read already running finishes within its deadline: it gives
/// way only once the log passes half the size at which exports are refused. A
/// 20,000-span trace held unread while exports take the log past 8 MiB, to 10 MiB, is then read
/// whole; held while they take it past 16 MiB, it gives way.
#[test]
fn a_running_read_finishes_while_the_gate_is_closed_until_the_log_nears_its_bound() {
    let _heavy = heavy();
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    let scratch = Scratch::new("preempt");
    let collector = Arc::new(Collector::start_capped(
        &scratch.data(),
        &["--max-store-mb", "64"],
    ));
    let big = "0000000000000000000000000000b2b2";
    send_large_trace(&collector, big, 20_000);
    let path = format!("/api/traces/{big}");
    // `count` senders of 500-span exports, back to back.
    let senders = |count: u64| {
        let stop = Arc::new(AtomicBool::new(false));
        let threads: Vec<std::thread::JoinHandle<()>> = (0..count)
            .map(|number| {
                let (stop, address) = (stop.clone(), collector.address.clone());
                std::thread::spawn(move || {
                    let mut ids = Ids((41 + number) << 40);
                    while !stop.load(Ordering::SeqCst) {
                        let _ = post_refusable(&address, &burst_export(&mut ids, 500, false));
                    }
                })
            })
            .collect();
        (stop, threads)
    };
    // A read held unread holds the log; exports take it past 8 MiB, so the gate closes, and stop at
    // 10 MiB, short of 16 MiB. Then the read is taken whole.
    let wal = |data: &Path| {
        std::fs::metadata(data.join("telemetry.sqlite-wal")).map_or(0, |meta| meta.len())
    };
    let mut held = stall(&collector, &path);
    let (stop, threads) = senders(1);
    let started = Instant::now();
    while wal(&scratch.data()) < 10 << 20 {
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "the log did not reach 10 MiB within 4 s"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    stop.store(true, Ordering::SeqCst);
    for thread in threads {
        thread.join().expect("sender");
    }
    let peak = wal(&scratch.data());
    let mut rest = Vec::new();
    held.read_to_end(&mut rest).expect("the rest of the read");
    let response = [b"HTTP/1.1 200".as_slice(), &rest].concat();
    let (_, _, body) = split_response(&response);
    let whole = dechunk(body).is_some();
    let (_, ingest) = collector.get("/api/ingest");
    assert!(peak < 16 << 20, "the log reached {peak} bytes: {ingest}");
    assert!(
        ingest["store"]["gateClosings"].as_u64() > Some(0),
        "{ingest}"
    );
    assert!(whole, "the read was cut off: {ingest}");
    assert_eq!(ingest["readers"]["yielded"], 0, "{ingest}");
    assert_eq!(ingest["refused"]["overBound"], 0, "{ingest}");
    // Flat out with a read held unread: once the log passes half its 32 MiB
    // refusal size, the read gives way at once, well before its deadline.
    let mut held = stall(&collector, &path);
    let read_started = Instant::now();
    let (stop, threads) = senders(4);
    while wal(&scratch.data()) <= 16 << 20 {
        assert!(
            read_started.elapsed() < Duration::from_secs(4),
            "the log did not pass 16 MiB within 4 s"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let passed = read_started.elapsed();
    let ingest = wait_for_ingest(&collector, Duration::from_secs(2), |ingest| {
        ingest["readers"]["yielded"].as_u64() > Some(0)
    });
    let gave_way = read_started.elapsed();
    stop.store(true, Ordering::SeqCst);
    for thread in threads {
        thread.join().expect("sender");
    }
    let mut rest = Vec::new();
    let _ = held.read_to_end(&mut rest);
    let response = [b"HTTP/1.1 200".as_slice(), &rest].concat();
    let (_, _, body) = split_response(&response);
    assert!(dechunk(body).is_none(), "the read was sent whole: {ingest}");
    assert!(
        gave_way < Duration::from_millis(4_500),
        "the log passed 16 MiB after {passed:?}, the read gave way after {gave_way:?}"
    );
    assert_eq!(ingest["readers"]["cutOff"], 0, "{ingest}");
}

/// Each route's `limit`: its default, and a limit over its maximum clamped to that maximum (the
/// e2e helpers send `limit=10000`), with enough rows to tell 100 from 500 apart, `meta` included;
/// and stats answer only `agg=count`.
#[test]
fn limits_take_each_routes_default_and_clamp_to_its_maximum() {
    use serde_json::json;
    let scratch = Scratch::new("limits");
    let collector = Collector::start(&scratch.data(), &[]);
    let one = "0000000000000000000000000000beef";
    // 150 traces of 4 spans, each with its own root name: 600 spans.
    for batch in 0..3u64 {
        let spans: Vec<Value> = (0..50u64)
            .flat_map(|index| {
                let number = batch * 50 + index;
                let trace = format!("{:032x}", 0x1_0000 + number);
                (0..4u64).map(move |span| {
                    json!({ "traceId": trace, "spanId": format!("{:016x}", number * 4 + span + 1),
                            "parentSpanId": if span == 0 { String::new() } else { format!("{:016x}", number * 4 + 1) },
                            "name": format!("op-{number}"), "startTimeUnixNano": ago(100.0 - number as f64 * 0.1 - span as f64 * 0.01),
                            "endTimeUnixNano": ago(99.0) })
                })
            })
            .collect();
        assert_eq!(
            collector.post("/v1/traces", &otlp_spans("many", spans)).0,
            200
        );
    }
    // 600 logs, all of one trace.
    let logs: Vec<Value> = (0..600u64)
        .map(|index| json!({ "timeUnixNano": ago(50.0 - index as f64 * 0.01), "body": { "stringValue": format!("log {index}") }, "traceId": one }))
        .collect();
    assert_eq!(collector.post("/v1/logs", &otlp_logs("many", logs)).0, 200);
    for (path, rows, limit) in [
        ("/api/traces?lookback=1h".to_owned(), 20, 20),
        ("/api/traces?lookback=1h&limit=10000".to_owned(), 100, 100),
        ("/api/traces?lookback=1h&limit=101".to_owned(), 100, 100),
        ("/api/spans/search?lookback=1h".to_owned(), 100, 100),
        (
            "/api/spans/search?lookback=1h&limit=10000".to_owned(),
            500,
            500,
        ),
        ("/api/logs?lookback=1h".to_owned(), 100, 100),
        ("/api/logs?lookback=1h&limit=10000".to_owned(), 500, 500),
        (
            "/api/logs/search?lookback=1h&limit=501".to_owned(),
            500,
            500,
        ),
        (format!("/api/traces/{one}/logs"), 100, 100),
        (format!("/api/traces/{one}/logs?limit=10000"), 500, 500),
        // Digits too many for a double are JavaScript's `Infinity`: the default, as in Motel.
        // One fewer that a double still holds (10^308) is clamped to the maximum.
        (
            format!("/api/traces?lookback=1h&limit={}", "9".repeat(309)),
            20,
            20,
        ),
        (
            format!("/api/traces?lookback=1h&limit=1{}", "0".repeat(308)),
            100,
            100,
        ),
        (
            format!("/api/spans/search?lookback=1h&limit={}", "9".repeat(400)),
            100,
            100,
        ),
        (
            format!("/api/logs?lookback=1h&limit={}", "9".repeat(309)),
            100,
            100,
        ),
        (
            format!("/api/logs?lookback=1h&limit=1{}", "0".repeat(308)),
            500,
            500,
        ),
    ] {
        let (status, body) = collector.get(&path);
        assert_eq!(status, 200, "{path}: {body}");
        assert_eq!(body["data"].as_array().map(Vec::len), Some(rows), "{path}");
        assert_eq!(
            (
                body["meta"]["limit"].clone(),
                body["meta"]["returned"].clone(),
                body["meta"]["truncated"].clone()
            ),
            (json!(limit), json!(rows), json!(true)),
            "{path}"
        );
    }
    // Stats: 150 root names, at most 100 groups; 20 by default.
    for (path, groups) in [
        (
            "/api/traces/stats?groupBy=operation&agg=count&lookback=1h",
            20,
        ),
        (
            "/api/traces/stats?groupBy=operation&agg=count&lookback=1h&limit=10000",
            100,
        ),
    ] {
        let (status, body) = collector.get(path);
        assert_eq!(status, 200, "{path}: {body}");
        assert_eq!(
            body["data"].as_array().map(Vec::len),
            Some(groups),
            "{path}"
        );
    }
    for (path, status, error) in [
        ("/api/traces/stats?groupBy=service&agg=count", 200, None),
        (
            "/api/traces/stats?groupBy=service",
            400,
            Some("Expected groupBy and agg=count|avg_duration|p95_duration|error_rate"),
        ),
        (
            "/api/traces/stats?agg=count",
            400,
            Some("Expected groupBy and agg=count|avg_duration|p95_duration|error_rate"),
        ),
        (
            "/api/traces/stats?groupBy=service&agg=bogus",
            400,
            Some("Expected groupBy and agg=count|avg_duration|p95_duration|error_rate"),
        ),
        (
            "/api/traces/stats?groupBy=service&agg=avg_duration",
            400,
            Some("Only agg=count is supported"),
        ),
        (
            "/api/traces/stats?groupBy=service&agg=p95_duration",
            400,
            Some("Only agg=count is supported"),
        ),
        (
            "/api/traces/stats?groupBy=service&agg=error_rate",
            400,
            Some("Only agg=count is supported"),
        ),
    ] {
        let (got, body) = collector.get(path);
        assert_eq!(got, status, "{path}: {body}");
        if let Some(error) = error {
            assert_eq!(body["error"], error, "{path}");
        }
    }
}

/// `severity` is upper-cased as JavaScript's `toUpperCase` does, every letter, then compared as
/// SQLite's `NOCASE` compares (ASCII only): `échec` finds `ÉCHEC`.
#[test]
fn severity_is_upper_cased_as_motel_did() {
    use serde_json::json;
    let scratch = Scratch::new("severity");
    let collector = Collector::start(&scratch.data(), &[]);
    let logs = otlp_logs(
        "svc",
        vec![
            json!({ "timeUnixNano": ago(10.0), "severityText": "ÉCHEC", "body": { "stringValue": "failed" } }),
            json!({ "timeUnixNano": ago(9.0), "severityText": "échec", "body": { "stringValue": "lower" } }),
        ],
    );
    assert_eq!(collector.post("/v1/logs", &logs).0, 200);
    let (status, body) = collector.get("/api/logs?severity=%C3%A9chec");
    assert_eq!(status, 200);
    let bodies: Vec<&str> = body["data"]
        .as_array()
        .expect("data")
        .iter()
        .map(|row| row["body"].as_str().expect("body"))
        .collect();
    assert_eq!(bodies, vec!["failed"], "{body}");
}

/// A trace of `spans` spans in exports of 50,000: a chain, each span the parent of the next, or
/// orphans, each with its own missing parent.
fn send_shaped_trace(collector: &Collector, trace: &str, spans: u64, orphans: bool) {
    for first in (0..spans).step_by(50_000) {
        let rows: Vec<String> = (first..(first + 50_000).min(spans))
            .map(|index| {
                let parent = if orphans {
                    format!("{:016x}", 0xf000_0000_0000 + index)
                } else if index == 0 {
                    String::new()
                } else {
                    format!("{:016x}", index)
                };
                format!(
                    r#"{{"traceId":"{trace}","spanId":"{:016x}","parentSpanId":"{parent}","name":"s","startTimeUnixNano":"{}","endTimeUnixNano":"{}"}}"#,
                    index + 1,
                    1_800_000_000_000_000_000u64 + index,
                    1_800_000_000_000_000_500u64 + index
                )
            })
            .collect();
        let body = format!(
            r#"{{"resourceSpans":[{{"resource":{{"attributes":[{{"key":"service.name","value":{{"stringValue":"huge"}}}}]}},"scopeSpans":[{{"spans":[{}]}}]}}]}}"#,
            rows.join(",")
        );
        let (status, answer) = collector.post("/v1/traces", body.as_bytes());
        assert_eq!(status, 200, "{answer}");
    }
}

/// A whole-trace answer's working memory has a ceiling whatever the trace holds: a trace whose
/// skeleton would take more than `SKELETON_BYTES` is answered with its first spans by start time,
/// and says so. 700,000 spans as a chain and as orphans each with its own missing parent, four
/// callers reading slowly: resident memory stays under four skeletons' ceiling plus their
/// buffers. (Before the ceiling, four callers of the orphans took the collector to 1,017 MiB.)
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn whole_trace_answers_stay_within_their_memory_ceiling() {
    let _heavy = heavy();
    use executor_collector::query::SKELETON_BYTES;
    for orphans in [true, false] {
        let shape = if orphans { "orphans" } else { "chain" };
        let scratch = Scratch::new(&format!("ceiling-{shape}"));
        let collector = Collector::start_capped(&scratch.data(), &[]);
        let trace = if orphans {
            "000000000000000000000000000c0de0"
        } else {
            "000000000000000000000000000c0de1"
        };
        send_shaped_trace(&collector, trace, 700_000, orphans);
        // The answer says it holds the first part of the trace, in its warnings, at its head.
        let mut stream = open_request(&collector, &format!("/api/traces/{trace}"));
        let mut head = vec![0u8; 1 << 16];
        let mut read = 0;
        while read < head.len() {
            match stream.read(&mut head[read..]) {
                Ok(0) | Err(_) => break,
                Ok(count) => read += count,
            }
        }
        drop(stream);
        let head = String::from_utf8_lossy(&head[..read]).into_owned();
        assert!(
            head.contains("the trace has 700000 spans; this answer holds the first"),
            "{shape}: {}",
            &head[..head.len().min(2_000)]
        );
        let baseline = settled_resident_kib(collector.pid());
        let path = format!("/api/traces/{trace}");
        let readers: Vec<std::thread::JoinHandle<()>> = (0..4)
            .map(|_| {
                let mut stream = open_request(&collector, &path);
                std::thread::spawn(move || {
                    let mut buffer = vec![0u8; 1 << 16];
                    let mut read = 0usize;
                    while read < 4 << 20 {
                        match stream.read(&mut buffer) {
                            Ok(0) | Err(_) => return,
                            Ok(count) => read += count,
                        }
                    }
                    // Hold the rest unread past the deadline.
                    std::thread::sleep(Duration::from_secs(6));
                })
            })
            .collect();
        let started = Instant::now();
        let mut peak = baseline;
        while started.elapsed() < Duration::from_secs(6) {
            peak = peak.max(resident_kib(collector.pid()));
            std::thread::sleep(Duration::from_millis(20));
        }
        for reader in readers {
            reader.join().expect("reader");
        }
        // Four skeletons at their ceiling, with 8 MiB each for the response's buffers and row.
        let ceiling = (4 * (SKELETON_BYTES + (8 << 20)) / 1024) as u64;
        eprintln!(
            "{shape}: resident {baseline} KiB before, {peak} KiB at most; ceiling {ceiling} KiB above"
        );
        assert!(
            peak - baseline < ceiling,
            "{shape}: {peak} KiB at most, from {baseline} KiB"
        );
        let (status, _, _) = collector.stop();
        assert!(status.success());
    }
}

unsafe extern "C" {
    fn signal(signal: i32, handler: usize) -> usize;
}

/// Start the collector with every file capped at `bytes` and `SIGXFSZ` ignored: a write past the
/// cap fails with an error instead of ending the process.
fn start_with_failing_writes_past(data: &Path, bytes: u64, extra: &[&str]) -> Collector {
    use std::os::unix::process::CommandExt;
    const RLIMIT_FSIZE: i32 = 1;
    const SIGXFSZ: i32 = 25;
    const SIG_IGN: usize = 1;
    let mut command = Command::new(BINARY);
    command
        .arg("serve")
        .arg("--data")
        .arg(data)
        .args(["--listen", "127.0.0.1:0"])
        .args(extra);
    // SAFETY: setrlimit and signal are async-signal-safe; the limit lives on this stack frame.
    unsafe {
        command.pre_exec(move || {
            let limit = [bytes, bytes];
            if setrlimit(RLIMIT_FSIZE, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            signal(SIGXFSZ, SIG_IGN);
            Ok(())
        });
    }
    Collector::spawn(&mut command).unwrap_or_else(|(status, stderr)| {
        panic!("the collector did not start ({status:?}): {stderr}")
    })
}

/// A read gate closed while checkpoints fail, not merely find readers, still opens after
/// `GATE_MOST`. Every file is capped at 16 MiB: on a 12 MiB database, an outside reader holds the
/// log while exports take it to 14 MiB, so the gate closes; once the reader ends, each checkpoint must grow the
/// database past the cap and fails. Readers are not held for good.
#[test]
fn the_read_gate_opens_after_its_limit_when_checkpoints_fail() {
    let scratch = Scratch::new("gate-error");
    let collector =
        start_with_failing_writes_past(&scratch.data(), 16 << 20, &["--max-store-mb", "1024"]);
    let mut ids = Ids(51 << 40);
    // A database of about 12 MiB first, with no reader: it checkpoints as it goes.
    while std::fs::metadata(scratch.database()).map_or(0, |meta| meta.len()) < 12 << 20 {
        assert_eq!(
            post_refusable(&collector.address, &burst_export(&mut ids, 1_000, false)),
            Some(200)
        );
    }
    let reader = Connection::open_with_flags(
        scratch.database(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("outside reader");
    reader.execute_batch("BEGIN").expect("begin");
    let _: i64 = reader
        .query_row("SELECT count(*) FROM spans", [], |row| row.get(0))
        .expect("read");
    let wal = || {
        std::fs::metadata(scratch.data().join("telemetry.sqlite-wal")).map_or(0, |meta| meta.len())
    };
    let started = Instant::now();
    while wal() < 14 << 20 {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the log did not grow"
        );
        let _ = post_refusable(&collector.address, &burst_export(&mut ids, 1_000, false));
    }
    let (_, ingest) = collector.get("/api/ingest");
    assert_eq!(ingest["store"]["gateClosed"], true, "{ingest}");
    let closings = ingest["store"]["gateClosings"].clone();
    reader.execute_batch("COMMIT").expect("end the read");
    // Checkpoints now fail; the gate must still open, by `GATE_MOST` after it closed.
    let ingest = wait_for_ingest(&collector, Duration::from_secs(8), |ingest| {
        ingest["store"]["gateClosed"] == false
    });
    assert_eq!(ingest["store"]["gateClosings"], closings, "{ingest}");
    assert!(
        ingest["store"]["walBytes"].as_u64() > Some(8 << 20),
        "the log was emptied: {ingest}"
    );
    let (status, _) = collector.get("/api/services");
    assert_eq!(status, 200);
    let (_, stderr, _) = collector.stop();
    assert!(
        stderr.contains("File too large") || stderr.contains("disk I/O error"),
        "{stderr}"
    );
}

/// A caller that hangs up while its query is inside SQLite is counted as gone, not as cut off at
/// the deadline: eight callers of a search that scans 250,000 spans hang up after 10 ms. (The
/// store is about 84 MB, the largest file the suite writes.)
#[test]
fn a_caller_hanging_up_during_sql_is_not_a_deadline_cut_off() {
    let _heavy = heavy();
    let scratch = Scratch::new("sql-cancel");
    let collector = Collector::start(&scratch.data(), &[]);
    send_large_trace(&collector, "0000000000000000000000000000ca9c", 250_000);
    let path = "/api/spans/search?lookback=7d&limit=500&attr.nothing=here";
    let started = Instant::now();
    let (status, _) = collector.get(path);
    assert_eq!(status, 200);
    let whole = started.elapsed();
    eprintln!("the search took {whole:?}");
    assert!(
        whole > Duration::from_millis(40),
        "the search took only {whole:?}"
    );
    let streams: Vec<TcpStream> = (0..8).map(|_| open_request(&collector, path)).collect();
    // Hang up once every reader is running a search, which takes the whole search's time in
    // SQLite: read as often as the status answers, so the searches have not ended yet.
    let asked = Instant::now();
    loop {
        let (_, ingest) = collector.get("/api/ingest");
        if ingest["readers"]["busy"] == ingest["readers"]["max"] {
            break;
        }
        assert!(
            asked.elapsed() < whole,
            "the readers were not all busy within a search's time: {ingest}"
        );
    }
    drop(streams);
    let ingest = wait_for_ingest(&collector, Duration::from_secs(10), |ingest| {
        ingest["readers"]["busy"] == 0
    });
    assert_eq!(ingest["readers"]["cutOff"], 0, "{ingest}");
}

/// A trace's spans route keeps no parent names: 8,000 spans with names as long as a name may be
/// (4 KiB, 32 MiB of names), children of one another, read by four slow callers, stay within the
/// same memory as the resource case (with a cache of names the reviewer measured 7 MiB to 153 MiB
/// for 31 MiB of names, then in 31 spans).
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn a_traces_spans_with_large_names_stay_small() {
    let _heavy = heavy();
    let scratch = Scratch::new("large-names");
    let collector = Collector::start(&scratch.data(), &[]);
    let trace = "0000000000000000000000000000a4e5";
    let count = 8_000u64;
    let name_bytes = executor_collector::otlp::NAME_BYTES - 4;
    for first in (0..count).step_by(1_000) {
        let spans: Vec<String> = (first..(first + 1_000).min(count))
            .map(|index| {
                let parent = if index == 0 {
                    String::new()
                } else {
                    format!("{index:016x}")
                };
                format!(
                    r#"{{"traceId":"{trace}","spanId":"{:016x}","parentSpanId":"{parent}","name":"{index:04}{}","startTimeUnixNano":"{}","endTimeUnixNano":"{}"}}"#,
                    index + 1,
                    "n".repeat(name_bytes),
                    ago(30.0 - index as f64 * 0.001),
                    ago(29.0)
                )
            })
            .collect();
        let body = format!(
            r#"{{"resourceSpans":[{{"resource":{{"attributes":[{{"key":"service.name","value":{{"stringValue":"names"}}}}]}},"scopeSpans":[{{"spans":[{}]}}]}}]}}"#,
            spans.join(",")
        );
        assert_eq!(collector.post("/v1/traces", body.as_bytes()).0, 200);
    }
    wait_for_ingest(&collector, Duration::from_secs(5), |ingest| {
        ingest["pending"] == 0 && ingest["store"]["maintenancePending"] == false
    });
    let baseline = settled_resident_kib(collector.pid());
    let path = format!("/api/traces/{trace}/spans");
    let readers: Vec<std::thread::JoinHandle<()>> = (0..4)
        .map(|_| {
            let mut stream = open_request(&collector, &path);
            std::thread::spawn(move || {
                let mut read = 0usize;
                let mut buffer = vec![0u8; 1 << 16];
                while read < 16 << 20 {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => return,
                        Ok(count) => read += count,
                    }
                }
                // Hold the rest unread past the deadline.
                std::thread::sleep(Duration::from_secs(6));
            })
        })
        .collect();
    let started = Instant::now();
    let mut peak = baseline;
    while started.elapsed() < Duration::from_secs(5) {
        peak = peak.max(resident_kib(collector.pid()));
        std::thread::sleep(Duration::from_millis(20));
    }
    for reader in readers {
        reader.join().expect("reader");
    }
    eprintln!("names: resident {baseline} KiB before, {peak} KiB at most");
    assert!(
        peak - baseline < 48 << 10,
        "{peak} KiB at most, from {baseline} KiB"
    );
}

/// A span past `EVENT_LIMIT` events keeps the first ones and says how many it dropped, in its
/// `warnings` on the trace and in a search; `/api/ingest` counts them, across a restart.
#[test]
fn events_past_the_limit_are_dropped_counted_and_warned() {
    use executor_collector::otlp::EVENT_LIMIT;
    use serde_json::json;
    let scratch = Scratch::new("events-dropped");
    let collector = Collector::start(&scratch.data(), &[]);
    let trace = "0000000000000000000000000000e0e0";
    let events: Vec<Value> = (0..EVENT_LIMIT + 2)
        .map(|index| json!({ "name": format!("e{index}"), "timeUnixNano": ago(10.0) }))
        .collect();
    let spans = vec![
        json!({ "traceId": trace, "spanId": "00000000000000e1", "name": "dense", "startTimeUnixNano": ago(10.0), "endTimeUnixNano": ago(9.0), "events": events }),
        json!({ "traceId": trace, "spanId": "00000000000000e2", "parentSpanId": "00000000000000e1", "name": "plain", "startTimeUnixNano": ago(10.0), "endTimeUnixNano": ago(9.0), "events": [{ "name": "one" }] }),
    ];
    assert_eq!(
        collector.post("/v1/traces", &otlp_spans("events", spans)).0,
        200
    );
    let warning = format!("2 events dropped: a span keeps its first {EVENT_LIMIT}");
    let (status, detail) = collector.get(&format!("/api/traces/{trace}"));
    assert_eq!(status, 200, "{detail}");
    let spans = detail["data"]["spans"].as_array().expect("spans");
    let dense = spans
        .iter()
        .find(|span| span["operationName"] == "dense")
        .expect("dense");
    let plain = spans
        .iter()
        .find(|span| span["operationName"] == "plain")
        .expect("plain");
    assert_eq!(dense["warnings"], json!([warning]));
    assert_eq!(dense["events"].as_array().map(Vec::len), Some(EVENT_LIMIT));
    assert_eq!(
        dense["events"][EVENT_LIMIT - 1]["name"],
        format!("e{}", EVENT_LIMIT - 1)
    );
    assert_eq!(plain["warnings"], json!([]));
    assert_eq!(plain["events"].as_array().map(Vec::len), Some(1));
    let (_, found) = collector.get("/api/spans/search?operation=dense&lookback=1h");
    assert_eq!(
        found["data"][0]["span"]["warnings"],
        json!([warning]),
        "{found}"
    );
    assert_eq!(collector.get("/api/ingest").1["droppedEvents"], 2);
    let (status, _, _) = collector.stop();
    assert!(status.success());
    let collector = Collector::start(&scratch.data(), &[]);
    assert_eq!(
        collector.get("/api/ingest").1["droppedEvents"],
        2,
        "kept across a restart"
    );
}

/// The reviewer's event-dense span: one export of 600 KB, one span with 200,000 empty events,
/// which stored an 8.9 MB row, read by four slow callers took the collector from 7 MiB to
/// 1,205 MiB. Now the row keeps 128 events, and four slow callers of the trace stay within the
/// readers' ceiling (`memory::reader_bytes`) and within a few MiB.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn an_event_dense_span_read_by_four_slow_callers_stays_small() {
    use executor_collector::memory;
    use executor_collector::readers::READERS;
    let _heavy = heavy();
    let scratch = Scratch::new("event-dense");
    let collector = Collector::start(&scratch.data(), &[]);
    let trace = "0000000000000000000000000000e0e1";
    let body = format!(
        r#"{{"resourceSpans":[{{"scopeSpans":[{{"spans":[{{"traceId":"{trace}","spanId":"00000000000000e1","name":"dense","startTimeUnixNano":"{}","endTimeUnixNano":"{}","events":[{}]}}]}}]}}]}}"#,
        ago(10.0),
        ago(9.0),
        vec!["{}"; 200_000].join(",")
    );
    assert!(body.len() < 700_000, "{}", body.len());
    assert_eq!(collector.post("/v1/traces", body.as_bytes()).0, 200);
    let stored: i64 = Connection::open(scratch.database())
        .expect("open")
        .query_row("SELECT length(events_json) FROM spans", [], |row| {
            row.get(0)
        })
        .expect("row");
    assert!(stored < 128 * 64, "the row's events take {stored} bytes");
    let baseline = settled_resident_kib(collector.pid());
    let path = format!("/api/traces/{trace}");
    let readers: Vec<std::thread::JoinHandle<()>> = (0..4)
        .map(|_| {
            let mut stream = open_request(&collector, &path);
            std::thread::spawn(move || {
                // Read a little, then hold the rest past the deadline.
                let mut buffer = vec![0u8; 512];
                let _ = stream.read(&mut buffer);
                std::thread::sleep(Duration::from_secs(6));
            })
        })
        .collect();
    let started = Instant::now();
    let mut peak = baseline;
    while started.elapsed() < Duration::from_secs(5) {
        peak = peak.max(resident_kib(collector.pid()));
        std::thread::sleep(Duration::from_millis(20));
    }
    for reader in readers {
        reader.join().expect("reader");
    }
    let ceiling = (READERS * memory::reader_bytes(16 << 20) / 1024) as u64;
    eprintln!("resident {baseline} KiB before, {peak} KiB at most; ceiling {ceiling} KiB");
    assert!(
        peak - baseline < ceiling,
        "{peak} KiB at most, from {baseline} KiB"
    );
    assert!(
        peak - baseline < 16 << 10,
        "{peak} KiB at most, from {baseline} KiB"
    );
}

/// Four exports at once, each at the size limit and made only of events. In one span each, they
/// are stored with 128 events and the rest counted as dropped; spread over spans of 128 empty
/// events, they take more than their budget to decode and are refused as too large. Either
/// way resident memory stays within four exports' ceiling (`memory::export_bytes`).
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn four_exports_made_only_of_events_stay_within_their_ceiling() {
    use executor_collector::memory;
    use executor_collector::otlp::EVENT_LIMIT;
    let _heavy = heavy();
    const LIMIT: usize = 16 << 20;
    let empties = |count: usize| vec!["{}"; count].join(",");
    let span = |trace: u64, number: u64, events: &str| {
        format!(
            r#"{{"traceId":"{trace:032x}","spanId":"{number:016x}","name":"e","startTimeUnixNano":"{}","endTimeUnixNano":"{}","events":[{events}]}}"#,
            ago(10.0),
            ago(9.0)
        )
    };
    let wrap = |spans: String| {
        format!(r#"{{"resourceSpans":[{{"scopeSpans":[{{"spans":[{spans}]}}]}}]}}"#).into_bytes()
    };
    for spread in [false, true] {
        let shape = if spread { "spread" } else { "one-span" };
        let scratch = Scratch::new(&format!("events-only-{shape}"));
        let collector = Collector::start_capped(&scratch.data(), &[]);
        let bodies: Vec<Vec<u8>> = (0..4u64)
            .map(|export| {
                let trace = 0xe0e0_0000 + export;
                if spread {
                    let one = span(trace, 1, &empties(EVENT_LIMIT));
                    let count = (LIMIT - 200) / (one.len() + 1);
                    wrap(
                        (0..count as u64)
                            .map(|number| span(trace, number + 1, &empties(EVENT_LIMIT)))
                            .collect::<Vec<_>>()
                            .join(","),
                    )
                } else {
                    wrap(span(trace, 1, &empties((LIMIT - 400) / 3)))
                }
            })
            .collect();
        assert!(
            bodies
                .iter()
                .all(|body| body.len() <= LIMIT && body.len() > LIMIT - (1 << 20))
        );
        let baseline = settled_resident_kib(collector.pid());
        let peak = std::sync::atomic::AtomicU64::new(baseline);
        let done = std::sync::atomic::AtomicBool::new(false);
        let statuses: Vec<u16> = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(std::sync::atomic::Ordering::SeqCst) {
                    peak.fetch_max(
                        resident_kib(collector.pid()),
                        std::sync::atomic::Ordering::SeqCst,
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
            let posts: Vec<_> = bodies
                .iter()
                .map(|body| scope.spawn(|| collector.post("/v1/traces", body).0))
                .collect();
            let statuses = posts
                .into_iter()
                .map(|post| post.join().expect("post"))
                .collect();
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            statuses
        });
        let peak = peak.into_inner();
        let ingest = collector.get("/api/ingest").1;
        let ceiling = (4 * memory::export_bytes(LIMIT) / 1024) as u64;
        eprintln!(
            "{shape}: resident {baseline} KiB before, {peak} KiB at most; ceiling {ceiling} KiB above; {ingest}"
        );
        assert!(
            peak - baseline < ceiling,
            "{shape}: {peak} KiB at most, from {baseline} KiB"
        );
        if spread {
            assert_eq!(statuses, vec![413; 4], "{shape}: {ingest}");
            assert_eq!(ingest["refused"]["tooLarge"], 4, "{shape}: {ingest}");
        } else {
            assert_eq!(statuses, vec![200; 4], "{shape}: {ingest}");
            let dropped = 4 * ((LIMIT - 400) / 3 - EVENT_LIMIT);
            assert_eq!(ingest["droppedEvents"], dropped, "{shape}");
            let largest: i64 = Connection::open(scratch.database())
                .expect("open")
                .query_row("SELECT max(length(events_json)) FROM spans", [], |row| {
                    row.get(0)
                })
                .expect("row");
            assert!(
                largest < 128 * 64,
                "{shape}: a row's events take {largest} bytes"
            );
        }
        let (status, _, _) = collector.stop();
        assert!(status.success());
    }
}

/// An export refused for what it holds is answered in a few hundred bytes, whatever it holds: a
/// 16 MiB span id, a 16 MiB number and a 16 MiB value of the wrong type are each named with at
/// most `otlp::MESSAGE_BYTES` of message, in the answer and in the log line. (The answer once
/// carried the whole id: 144 callers who stopped reading held 2.4 GiB.)
#[test]
fn a_refused_export_is_answered_briefly_whatever_it_holds() {
    use executor_collector::otlp::MESSAGE_BYTES;
    let scratch = Scratch::new("brief-errors");
    let collector = Collector::start(&scratch.data(), &[]);
    let fill = (16 << 20) - 400;
    let span = |fields: String| {
        format!(r#"{{"resourceSpans":[{{"scopeSpans":[{{"spans":[{{{fields}}}]}}]}}]}}"#)
    };
    let cases = [
        (
            "an invalid id",
            span(format!(
                r#""traceId":"{}","spanId":"0000000000000001""#,
                "!".repeat(fill)
            )),
            "Invalid trace id",
        ),
        (
            "a number out of range",
            span(format!(
                r#""traceId":"{}","spanId":"0000000000000001","startTimeUnixNano":"{}""#,
                "0".repeat(32),
                "9".repeat(fill)
            )),
            "not a whole number",
        ),
        (
            "a value of the wrong type",
            span(format!(
                r#""traceId":"{}","spanId":"0000000000000001","name":["{}"]"#,
                "0".repeat(32),
                "x".repeat(fill)
            )),
            "Invalid traces export",
        ),
        (
            "a string where a boolean is expected",
            span(format!(
                r#""traceId":"{}","spanId":"0000000000000001","attributes":[{{"key":"b","value":{{"boolValue":"{}"}}}}]"#,
                "0".repeat(32),
                "\u{1F600}".repeat(fill / 4)
            )),
            "expected a boolean for boolValue, found the string",
        ),
        (
            "a string where an object is expected",
            format!(
                r#"{{"resourceSpans":[{{"resource":"{}","scopeSpans":[]}}]}}"#,
                "x".repeat(fill)
            ),
            "expected a resource (an object), found the string",
        ),
        (
            "a string where the spans list is expected",
            format!(
                r#"{{"resourceSpans":[{{"scopeSpans":[{{"spans":"{}"}}]}}]}}"#,
                "x".repeat(fill)
            ),
            "expected a list of spans (objects), found the string",
        ),
        (
            "a string where the resourceSpans list is expected",
            format!(r#"{{"resourceSpans":"{}"}}"#, "\u{1F600}".repeat(fill / 4)),
            "expected a list of resourceSpans entries (objects), found the string",
        ),
        (
            "a string where the scopeSpans list is expected",
            format!(
                r#"{{"resourceSpans":[{{"scopeSpans":"{}"}}]}}"#,
                "x".repeat(fill)
            ),
            "expected a list of scopeSpans entries (objects), found the string",
        ),
        (
            "a string where the attributes list is expected",
            span(format!(
                r#""traceId":"{}","spanId":"0000000000000001","attributes":"{}""#,
                "0".repeat(32),
                "x".repeat(fill)
            )),
            "expected a list of attributes (KeyValue objects), found the string",
        ),
    ];
    for (case, body, expected) in &cases {
        assert!(body.len() <= 16 << 20);
        let (status, answer) = collector.post("/v1/traces", body.as_bytes());
        assert_eq!(status, 400, "{case}");
        let message = answer["error"].as_str().expect("a message");
        assert!(message.contains(expected), "{case}: {message}");
        // Where comes first, then what was expected, then at most a short excerpt of the value:
        // a cut never falls on the useful part.
        if message.starts_with("Invalid traces export") {
            assert!(
                message.starts_with("Invalid traces export at line 1 column "),
                "{case}: {message}"
            );
        }
        assert!(
            message.len() <= MESSAGE_BYTES,
            "{case}: {} bytes",
            message.len()
        );
        let answered = serde_json::to_string(&answer).expect("JSON").len();
        assert!(
            answered <= 2 * MESSAGE_BYTES,
            "{case}: an answer of {answered} bytes"
        );
    }
    let (status, stderr, _) = collector.stop();
    assert!(status.success());
    let longest = stderr.lines().map(str::len).max().unwrap_or(0);
    assert!(longest < 16 << 10, "a log line of {longest} bytes");
}

/// The store records the largest `--max-export-bytes` it has been started with. Started with
/// the same or a larger limit it keeps everything; started with a smaller one it is emptied in
/// place, with one log line, as a store of another format is, so every stored row was admitted
/// under a limit no larger than the current one. A limit outside the accepted range does not
/// start.
#[test]
fn a_lowered_export_limit_empties_the_store_and_a_raised_one_keeps_it() {
    let scratch = Scratch::new("lowered-limit");
    let trace = "0000000000000000000000000000c1a5";
    let stored = |data: &Path| {
        let connection =
            Connection::open(executor_collector::store::database_path(data)).expect("open");
        count(&connection, "SELECT count(*) FROM spans")
    };
    let run = |limit: &str| {
        let collector = Collector::start(&scratch.data(), &["--max-export-bytes", limit]);
        let (status, _, _) = collector.stop();
        assert!(status.success());
    };
    {
        let collector = Collector::start(&scratch.data(), &["--max-export-bytes", "8388608"]);
        assert_eq!(
            collector
                .post("/v1/traces", &small_export(trace, "00000000000000c1"))
                .0,
            200
        );
        let (status, _, _) = collector.stop();
        assert!(status.success());
    }
    run("8388608");
    assert_eq!(stored(&scratch.data()), 1, "the same limit kept the store");
    run("16777216");
    assert_eq!(stored(&scratch.data()), 1, "a larger limit kept the store");
    let collector = Collector::start(&scratch.data(), &["--max-export-bytes", "8388608"]);
    let (status, stderr, _) = collector.stop();
    assert!(status.success());
    assert!(
        stderr.contains(
            "emptied the telemetry store: it has been started with a larger --max-export-bytes"
        ),
        "{stderr}"
    );
    assert_eq!(
        stored(&scratch.data()),
        0,
        "a smaller limit kept rows admitted under a larger one"
    );
    for limit in ["65535", "134217729"] {
        let refused = Collector::try_start(&scratch.data(), &["--max-export-bytes", limit]);
        let Err((status, stderr)) = refused else {
            panic!("the collector started with --max-export-bytes {limit}");
        };
        assert!(!status.success(), "{limit}");
        assert!(
            stderr.contains("--max-export-bytes must be from 65536 to 134217728"),
            "{limit}: {stderr}"
        );
    }
}

/// The name cap applies to every name and key the collector decodes and keeps. Past
/// `VALUE_DEPTH` a value is kept as raw text, events after the 128th are dropped unread, and of
/// a resource's duplicate `service.name` only the last is kept and checked. Every other value
/// decoded has its nested keys checked, whether or not a later value for the same key replaces
/// it. Each boundary through a real request: a 4,097-byte key under 64 arrays is refused and
/// under 65 stored inside the value's text; event 128's long name is refused and event 129's
/// dropped and counted; a long key in an attribute value a later value replaces is refused; a
/// long first `service.name` with a short last one is stored under the short one. In
/// each accepted case the long text is in no list, summary, header or stored name.
#[test]
fn names_the_collector_does_not_decode_or_keep_are_not_checked() {
    use executor_collector::otlp::{EVENT_LIMIT, NAME_BYTES, VALUE_DEPTH};
    use serde_json::json;
    let scratch = Scratch::new("unchecked-names");
    let collector = Collector::start(&scratch.data(), &[]);
    let long = "k".repeat(NAME_BYTES + 1);
    let mut traces = 0u64;
    let mut span_with = |extra: Value, resource: Vec<Value>| {
        traces += 1;
        let trace = format!("{:032x}", 0xdee9_0000 + traces);
        let mut span = json!({ "traceId": trace, "spanId": "000000000000dee9", "name": "plain-op",
            "startTimeUnixNano": ago(10.0), "endTimeUnixNano": ago(9.0) });
        for (key, value) in extra.as_object().expect("fields") {
            span[key] = value.clone();
        }
        let body = serde_json::to_vec(&json!({ "resourceSpans": [{
            "resource": { "attributes": resource },
            "scopeSpans": [{ "scope": { "name": "plain-scope" }, "spans": [span] }],
        }] }))
        .expect("json");
        (trace, body)
    };
    let service = |name: &str| json!({ "key": "service.name", "value": { "stringValue": name } });
    let nested = |depth: usize| {
        let mut value = json!({ "kvlistValue": { "values": [
            { "key": long, "value": { "stringValue": "v" } }
        ] } });
        for _ in 0..depth {
            value = json!({ "arrayValue": { "values": [value] } });
        }
        json!({ "attributes": [{ "key": "container", "value": value }] })
    };
    let events = |count: usize| {
        let mut events: Vec<Value> = (0..count - 1).map(|_| json!({ "name": "e" })).collect();
        events.push(json!({ "name": long }));
        json!({ "events": events })
    };

    // Every value decoded has its nested keys checked, even one a later value for the same key
    // replaces: an attribute `outer` whose first value holds a long key, and whose last is short.
    let replaced = json!({ "attributes": [
        { "key": "outer", "value": { "kvlistValue": { "values": [
            { "key": long, "value": { "stringValue": "v" } }
        ] } } },
        { "key": "outer", "value": { "stringValue": "short" } },
    ] });
    // Decoded, and refused: the key at depth 64, event 128's name, the replaced value's key.
    for (case, extra) in [
        ("depth 64", nested(VALUE_DEPTH)),
        ("event 128", events(EVENT_LIMIT)),
        ("a replaced value's key", replaced),
    ] {
        let (_, body) = span_with(extra, vec![service("plain")]);
        let (status, answer) = collector.post("/v1/traces", &body);
        assert_eq!(status, 400, "{case}: {answer}");
    }
    // Not decoded or not kept, and stored.
    let (deep, body) = span_with(nested(VALUE_DEPTH + 1), vec![service("plain")]);
    assert_eq!(collector.post("/v1/traces", &body).0, 200, "depth 65");
    let (dropped, body) = span_with(events(EVENT_LIMIT + 1), vec![service("plain")]);
    assert_eq!(collector.post("/v1/traces", &body).0, 200, "event 129");
    let (duplicate, body) = span_with(json!({}), vec![service(&long), service("short")]);
    assert_eq!(
        collector.post("/v1/traces", &body).0,
        200,
        "duplicate service.name"
    );

    // Depth 65: the key is in the attribute's text, and is no tag's key.
    let (_, detail) = collector.get(&format!("/api/traces/{deep}"));
    let tags = detail["data"]["spans"][0]["tags"]
        .as_object()
        .expect("tags")
        .clone();
    assert!(
        tags["container"]
            .as_str()
            .is_some_and(|text| text.contains(&long)),
        "the deep key is not in the value's text"
    );
    assert!(tags.keys().all(|key| key.len() <= NAME_BYTES));
    // Event 129: dropped and counted.
    let (_, detail) = collector.get(&format!("/api/traces/{dropped}"));
    let span = &detail["data"]["spans"][0];
    assert_eq!(
        span["events"].as_array().map(Vec::len),
        Some(EVENT_LIMIT),
        "{}",
        span["warnings"]
    );
    assert!(
        span["warnings"].to_string().contains("1 events dropped"),
        "{}",
        span["warnings"]
    );
    assert_eq!(collector.get("/api/ingest").1["droppedEvents"], 1);
    // The duplicate: stored under the last, short name.
    let (_, detail) = collector.get(&format!("/api/traces/{duplicate}"));
    assert_eq!(detail["data"]["serviceName"], "short", "{}", detail["data"]);

    // No list, summary or header names the long text; only the depth-65 span's own answer holds
    // it, in that attribute's value.
    let probe = &long[..64];
    for path in [
        "/api/services".to_owned(),
        "/api/traces?lookback=1h&limit=100".to_owned(),
        "/api/traces/stats?groupBy=service&agg=count".to_owned(),
        "/api/traces/stats?groupBy=operation&agg=count".to_owned(),
        format!("/api/traces/{dropped}"),
        format!("/api/traces/{duplicate}"),
        format!("/api/traces/{dropped}/spans"),
        format!("/api/traces/{duplicate}/spans"),
        "/api/spans/search?lookback=1h&operation=plain".to_owned(),
    ] {
        let (status, body) = collector.get(&path);
        assert_eq!(status, 200, "{path}");
        let shown = if path.starts_with("/api/spans/search") {
            // The search answers the depth-65 span too, its tags included: only names count.
            let names: Vec<Value> = body["data"]
                .as_array()
                .expect("rows")
                .iter()
                .map(|row| {
                    let span = &row["span"];
                    json!([
                        span["operationName"],
                        span["serviceName"],
                        span["scopeName"],
                        span["parentOperationName"],
                        span["events"]
                    ])
                })
                .collect();
            Value::Array(names)
        } else {
            body
        };
        assert!(
            !shown.to_string().contains(probe),
            "{path} holds the long text"
        );
    }
    let (status, _, _) = collector.stop();
    assert!(status.success());
    // Stored: only inside the depth-65 span's attributes, never as a name, a service, a summary
    // or an event.
    let connection = Connection::open(scratch.database()).expect("open");
    let holding = |sql: &str| {
        connection
            .query_row(sql, [probe], |row| row.get::<_, i64>(0))
            .expect("query")
    };
    for sql in [
        "SELECT count(*) FROM services WHERE instr(name, ?1)",
        "SELECT count(*) FROM resources WHERE instr(service_name, ?1) OR instr(attributes_json, ?1)",
        "SELECT count(*) FROM traces WHERE instr(coalesce(root_name, ''), ?1)",
        "SELECT count(*) FROM spans WHERE instr(name, ?1) OR instr(coalesce(scope_name, ''), ?1) OR instr(coalesce(events_json, ''), ?1)",
    ] {
        assert_eq!(holding(sql), 0, "{sql}");
    }
    assert_eq!(
        holding("SELECT count(*) FROM spans WHERE instr(attributes_json, ?1)"),
        1,
        "the depth-65 value"
    );
}

/// An export that would grow the store past what one export may add (`store::WriteLimit`, 20
/// times `--max-export-bytes` for the database and for the log) is refused with 413, counted as
/// `tooMuchDisk`, and leaves the store as it was. At the smallest limit (64 KiB, so 1.25 MiB of
/// log), an export re-sending every 32nd of 12,160 stored spans with a new end touches a page or
/// more per span.
#[test]
fn an_export_that_writes_too_much_to_disk_is_refused_and_leaves_the_store_as_it_was() {
    let scratch = Scratch::new("too-much-disk");
    let limit = ["--max-export-bytes", "65536"];
    let export = |first: u64, every: u64, count: u64, end: f64| {
        let spans: Vec<Value> = (0..count)
            .map(|index| {
                let trace = first + index * every;
                serde_json::json!({ "traceId": format!("{:032x}", 0xd15c_0000_u64 + trace),
                    "spanId": format!("{:016x}", trace + 1), "name": "op",
                    "startTimeUnixNano": ago(60.0), "endTimeUnixNano": ago(end) })
            })
            .collect();
        otlp_spans("disk", spans)
    };
    let collector = Collector::start(&scratch.data(), &limit);
    for first in (0..12_160).step_by(380) {
        let body = export(first, 1, 380, 59.0);
        assert!(body.len() <= 65_536, "{} bytes", body.len());
        assert_eq!(collector.post("/v1/traces", &body).0, 200);
    }
    let (status, _, _) = collector.stop();
    assert!(status.success());
    let rows = |data: &Path| {
        let connection =
            Connection::open(executor_collector::store::database_path(data)).expect("open");
        [
            "SELECT count(*) FROM spans",
            "SELECT sum(end_ns % 1000000000) FROM spans",
            "SELECT count(*) FROM traces",
            "SELECT sum(ended_ns % 1000000000) FROM traces",
            "SELECT count(*) FROM services",
            "SELECT count(*) FROM resources",
        ]
        .map(|sql| count(&connection, sql))
    };
    let before = rows(&scratch.data());
    let collector = Collector::start(&scratch.data(), &limit);
    let body = export(0, 32, 380, 30.0);
    assert!(body.len() <= 65_536, "{} bytes", body.len());
    let (status, answer) = collector.post("/v1/traces", &body);
    assert_eq!(status, 413, "{answer}");
    assert_eq!(
        answer["error"],
        "Telemetry export takes more disk to store than the collector allows"
    );
    let (_, ingest) = collector.get("/api/ingest");
    assert_eq!(ingest["refused"]["tooMuchDisk"], 1, "{ingest}");
    assert_eq!(ingest["refused"]["storeFailed"], 0, "{ingest}");
    // An ordinary export still goes in afterwards.
    assert_eq!(
        collector.post("/v1/traces", &export(20_000, 1, 10, 59.0)).0,
        200
    );
    let (status, _, _) = collector.stop();
    assert!(status.success());
    let after = rows(&scratch.data());
    assert_eq!(after[0], before[0] + 10, "the refused export's spans");
    assert_eq!(after[1] - before[1], {
        // Only the ten new spans add to the ends.
        let connection =
            Connection::open(executor_collector::store::database_path(&scratch.data()))
                .expect("open");
        count(
            &connection,
            "SELECT sum(end_ns % 1000000000) FROM spans WHERE trace IN (SELECT id FROM traces ORDER BY id DESC LIMIT 10)",
        )
    });
    assert_eq!(after[2], before[2] + 10);
    assert_eq!((after[4], after[5]), (before[4], before[5]));
}
