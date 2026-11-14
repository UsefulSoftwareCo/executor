//! The built `executor-collector` binary as a process: stopping, its socket, acknowledging only
//! stored exports, creating its store when interrupted, deep nesting at the size limit and with
//! a small stack in the environment, and returning memory after a burst.
#![cfg(unix)]

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
        let path = std::env::temp_dir().join(format!(
            "executor-collector-process-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("scratch directory");
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

fn exchange(address: &Address, raw: &[u8]) -> (u16, Value) {
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
    let text = String::from_utf8(response).expect("UTF-8 response");
    let status = text[9..12].parse().expect("status code");
    let body = text.split_once("\r\n\r\n").map_or("", |(_, body)| body);
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
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
    let collector = Collector::start(&scratch.data(), &["--max-export-bytes", "300"]);
    let chunked = |payload: &[u8]| {
        let mut raw = b"POST /v1/traces HTTP/1.1\r\nHost: collector\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
        raw.extend_from_slice(format!("{:x}\r\n", payload.len()).as_bytes());
        raw.extend_from_slice(payload);
        raw.extend_from_slice(b"\r\n0\r\n\r\n");
        exchange(&collector.address, &raw)
    };
    assert_eq!(chunked(b"not json").0, 400);
    assert_eq!(collector.get("/api/ingest").1["refusedBytes"], 8);
    assert_eq!(chunked(&[b' '; 400]).0, 413);
    let refused = collector.get("/api/ingest").1["refusedBytes"]
        .as_u64()
        .expect("bytes");
    assert!(
        (8 + 301..=8 + 400).contains(&refused),
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
/// a lost connection and retries like a 429. `None` for that.
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
    let text = String::from_utf8_lossy(&response);
    Some(text[9..12].parse().expect("status code"))
}

/// One export of `spans` spans of the trace `trace`, starting at span number `first`.
fn trace_export(trace: &str, first: u64, spans: u64) -> Vec<u8> {
    let rows: Vec<String> = (first..first + spans)
        .map(|span| {
            format!(
                r#"{{"traceId":"{trace}","spanId":"{:016x}","name":"step","startTimeUnixNano":"{}","endTimeUnixNano":"{}","attributes":[{{"key":"k","value":{{"stringValue":"{}"}}}}]}}"#,
                span + 1,
                1_000 + span,
                2_000 + span,
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
