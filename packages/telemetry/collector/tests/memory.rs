//! What decoding, storing and answering really hold, measured: this binary counts every
//! allocation (the Rust heap, at glibc's chunk sizes, and SQLite's own), and for each shape of a
//! generated corpus of exports checks the peak against what the code allows it:
//!
//! - decoding holds at most what it was charged (`otlp::decode_spans_charged`) and a small fixed
//!   allowance, plus the escaped text it unescapes when the export has any; a refused export is
//!   refused before it holds more than its budget and that allowance;
//! - the writer storing the result holds at most `memory::writer_bytes`;
//! - a reader answering from it holds at most `memory::reader_bytes`.
//!
//! So a charge removed or an allocation added that the charges do not cover makes a shape pass
//! its allowance. One test runs the whole corpus, so nothing else allocates beside it.

mod support;

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use executor_collector::otlp::{self, DECODE_SHARE, Logs, MESSAGE_BYTES, Spans, Undecodable};
use executor_collector::query::{self, LogFilter, Query};
use executor_collector::readers::answer_length;
use executor_collector::{memory, store};
use rusqlite::Connection;

/// Counts what the heap holds, at the size glibc's allocator gives each request.
struct Meter;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

/// The chunk glibc gives a request of `size` bytes: its size and 8 bytes of header, rounded up
/// to 16, at least 32.
fn chunk(size: usize) -> usize {
    ((size + 8 + 15) & !15).max(32)
}

unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            let now = LIVE.fetch_add(chunk(layout.size()), Ordering::SeqCst) + chunk(layout.size());
            PEAK.fetch_max(now, Ordering::SeqCst);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        LIVE.fetch_sub(chunk(layout.size()), Ordering::SeqCst);
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, size) };
        if !moved.is_null() {
            // Both copies are counted while the old one is copied from.
            let now = LIVE.fetch_add(chunk(size), Ordering::SeqCst) + chunk(size);
            PEAK.fetch_max(now, Ordering::SeqCst);
            LIVE.fetch_sub(chunk(layout.size()), Ordering::SeqCst);
        }
        moved
    }
}

#[global_allocator]
static METER: Meter = Meter;

/// Taken by every test here: the meter counts the whole process, so they run one at a time.
fn alone() -> std::sync::MutexGuard<'static, ()> {
    static ALONE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    ALONE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The most `work` held above what was held when it started: the Rust heap's peak and SQLite's.
fn measure<T>(work: impl FnOnce() -> T) -> (T, usize) {
    let base = LIVE.load(Ordering::SeqCst);
    PEAK.store(base, Ordering::SeqCst);
    // SAFETY: reads and resets SQLite's own memory statistics; no pointer is involved.
    let sqlite_base = unsafe {
        rusqlite::ffi::sqlite3_memory_highwater(1);
        rusqlite::ffi::sqlite3_memory_used()
    };
    let result = work();
    let rust = PEAK.load(Ordering::SeqCst).saturating_sub(base);
    // SAFETY: as above.
    let sqlite = unsafe { rusqlite::ffi::sqlite3_memory_highwater(0) } - sqlite_base;
    (result, rust + sqlite.max(0) as usize)
}

/// What decoding may hold beside its charges: the buffers serde_json and the decoder keep for the
/// value they are reading (the largest is a few kilobytes but for escaped text).
const UNCHARGED_BYTES: usize = 64 << 10;

/// The size limit the corpus is made for.
const LIMIT: usize = 1 << 20;

fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos() as u64
}

fn trace_id(number: usize) -> String {
    format!("{:032x}", 0x5ca1_e000_0000_usize + number)
}

fn span(trace: usize, number: usize, extra: &str) -> String {
    let start = now_ns() - 60_000_000_000;
    format!(
        r#"{{"traceId":"{}","spanId":"{:016x}","name":"op","startTimeUnixNano":"{start}","endTimeUnixNano":"{}"{extra}}}"#,
        trace_id(trace),
        number + 1,
        start + 1_000
    )
}

/// As many copies of `item(index)` as fit in `bytes`, joined with commas.
fn fill(bytes: usize, mut item: impl FnMut(usize) -> String) -> String {
    let mut out = String::new();
    let mut index = 0;
    loop {
        let next = item(index);
        if out.len() + next.len() + 1 > bytes {
            return out;
        }
        if index > 0 {
            out.push(',');
        }
        out.push_str(&next);
        index += 1;
    }
}

fn traces(resource: &str, scope: &str, spans: &str) -> Vec<u8> {
    format!(
        r#"{{"resourceSpans":[{{"resource":{{"attributes":[{resource}]}},"scopeSpans":[{{"scope":{{"name":"{scope}"}},"spans":[{spans}]}}]}}]}}"#
    )
    .into_bytes()
}

fn service(name: &str) -> String {
    format!(r#"{{"key":"service.name","value":{{"stringValue":"{name}"}}}}"#)
}

fn logs(records: &str) -> Vec<u8> {
    format!(
        r#"{{"resourceLogs":[{{"resource":{{"attributes":[{}]}},"scopeLogs":[{{"scope":{{"name":"s"}},"logRecords":[{records}]}}]}}]}}"#,
        service("logs")
    )
    .into_bytes()
}

fn nested(depth: usize, leaf: &str) -> String {
    format!(
        "{}{leaf}{}",
        r#"{"arrayValue":{"values":["#.repeat(depth),
        "]}}".repeat(depth)
    )
}

/// Arrays `depth` deep, each holding the next and an integer beside it.
fn deep_wide(depth: usize) -> String {
    let mut value = r#"{"intValue":"0"}"#.to_owned();
    for level in 0..depth {
        value = format!(r#"{{"arrayValue":{{"values":[{value},{{"intValue":"{level}"}}]}}}}"#);
    }
    value
}

enum Signal {
    Traces,
    Logs,
}

/// The corpus: each shape at a quarter of the limit and just under it.
fn corpus() -> Vec<(String, Signal, Vec<u8>)> {
    let mut shapes: Vec<(String, Signal, Vec<u8>)> = Vec::new();
    for (size, label) in [(LIMIT / 4, "1/4"), (LIMIT - 1024, "full")] {
        let room = size - 400;
        let mut add = |name: &str, signal: Signal, body: Vec<u8>| {
            assert!(body.len() <= LIMIT, "{name} {label}: {} bytes", body.len());
            shapes.push((format!("{name} ({label})"), signal, body));
        };
        add(
            "product-like spans",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &fill(room, |index| {
                    span(
                        index / 30,
                        index,
                        &format!(
                            r#","kind":1,"attributes":[{{"key":"db.query.text","value":{{"stringValue":"SELECT * FROM notes WHERE id = ? AND owner = ? -- {index:0>150}"}}}},{{"key":"app.step","value":{{"intValue":"{}"}}}}]"#,
                            index % 30
                        ),
                    )
                }),
            ),
        );
        add(
            "spans of ids only",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &fill(room, |index| span(index, index, "")),
            ),
        );
        add(
            "one span of empty events",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(
                    0,
                    0,
                    &format!(r#","events":[{}]"#, fill(room - 200, |_| "{}".to_owned())),
                ),
            ),
        );
        add(
            "spans of 128 empty events",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &fill(room, |index| {
                    span(
                        index,
                        index,
                        &format!(r#","events":[{}]"#, vec!["{}"; 128].join(",")),
                    )
                }),
            ),
        );
        add(
            "spans of a few events",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &fill(room, |index| {
                    span(
                        index / 10,
                        index,
                        r#","events":[{"name":"e","timeUnixNano":"1","attributes":[{"key":"k","value":{"intValue":"1"}}]},{"name":"f"}]"#,
                    )
                }),
            ),
        );
        add(
            "many tiny attributes",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(
                    0,
                    0,
                    &format!(
                        r#","attributes":[{}]"#,
                        fill(room - 200, |index| format!(r#"{{"key":"{index:x}"}}"#))
                    ),
                ),
            ),
        );
        add(
            "one long attribute",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(
                    0,
                    0,
                    &format!(
                        r#","attributes":[{{"key":"long","value":{{"stringValue":"{}"}}}}]"#,
                        "v".repeat(room - 300)
                    ),
                ),
            ),
        );
        add(
            "one long escaped attribute",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(
                    0,
                    0,
                    &format!(
                        r#","attributes":[{{"key":"long","value":{{"stringValue":"{}"}}}}]"#,
                        "\\u0001\\\"".repeat((room - 300) / 8)
                    ),
                ),
            ),
        );
        add(
            "values at depth 64",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &fill(room, |index| {
                    span(
                        index,
                        index,
                        &format!(
                            r#","attributes":[{{"key":"deep","value":{}}}]"#,
                            nested(otlp::VALUE_DEPTH - 1, r#"{"stringValue":"leaf"}"#)
                        ),
                    )
                }),
            ),
        );
        add(
            "a value past depth 64",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(
                    0,
                    0,
                    &format!(
                        r#","attributes":[{{"key":"deep","value":{}}}]"#,
                        nested((room - 300) / 30, r#"{"stringValue":"leaf"}"#)
                    ),
                ),
            ),
        );
        add(
            "arrays of empty values",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(
                    0,
                    0,
                    &format!(
                        r#","attributes":[{{"key":"a","value":{{"arrayValue":{{"values":[{}]}}}}}}]"#,
                        fill(room - 300, |_| "{}".to_owned())
                    ),
                ),
            ),
        );
        add(
            "key-value lists",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(
                    0,
                    0,
                    &format!(
                        r#","attributes":[{{"key":"a","value":{{"kvlistValue":{{"values":[{}]}}}}}}]"#,
                        fill(room - 300, |index| format!(
                            r#"{{"key":"{index:x}","value":{{"intValue":"{index}"}}}}"#
                        ))
                    ),
                ),
            ),
        );
        add(
            "a shared long scope name",
            Signal::Traces,
            traces(
                &service("svc"),
                &"s".repeat(room / 2),
                &fill(room / 2 - 100, |index| span(index, index, "")),
            ),
        );
        add(
            "a shared long service name over many traces",
            Signal::Traces,
            traces(
                &service(&"n".repeat(room / 2)),
                "s",
                &fill(room / 2 - 100, |index| span(index, index, "")),
            ),
        );
        add(
            "many resources",
            Signal::Traces,
            format!(
                r#"{{"resourceSpans":[{}]}}"#,
                fill(room, |index| format!(
                    r#"{{"resource":{{"attributes":[{}]}},"scopeSpans":[{{"spans":[{}]}}]}}"#,
                    service(&format!("s{index}")),
                    span(index, index, "")
                ))
            )
            .into_bytes(),
        );
        add(
            "many scopes",
            Signal::Traces,
            format!(
                r#"{{"resourceSpans":[{{"resource":{{"attributes":[{}]}},"scopeSpans":[{}]}}]}}"#,
                service("svc"),
                fill(room, |index| format!(
                    r#"{{"scope":{{"name":"scope{index}"}},"spans":[{}]}}"#,
                    span(index, index, "")
                ))
            )
            .into_bytes(),
        );
        add(
            "a span with an invalid id",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &format!(
                    r#"{{"traceId":"{}","spanId":"0000000000000001"}}"#,
                    "!".repeat(room - 200)
                ),
            ),
        );
        add(
            "spans with long names",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &fill(room, |index| {
                    span(index, index, "").replacen(
                        r#""name":"op""#,
                        &format!(r#""name":"{}""#, "n".repeat(300)),
                        1,
                    )
                }),
            ),
        );
        add(
            "spans with escaped names",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &fill(room, |index| {
                    span(index, index, "").replacen(
                        r#""name":"op""#,
                        &format!(r#""name":"{}""#, r"a\nb".repeat(60)),
                        1,
                    )
                }),
            ),
        );
        add(
            "a span of 128 events with long names",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(
                    0,
                    0,
                    &format!(
                        r#","events":[{}]"#,
                        (0..128)
                            .map(|_| format!(
                                r#"{{"name":"{}"}}"#,
                                "e".repeat((room - 2_000) / 128 - 12)
                            ))
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                ),
            ),
        );
        add(
            "arrays of integers",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(
                    0,
                    0,
                    &format!(
                        r#","attributes":[{{"key":"a","value":{{"arrayValue":{{"values":[{}]}}}}}}]"#,
                        fill(room - 300, |index| format!(
                            r#"{{"intValue":"{}"}}"#,
                            index % 10
                        ))
                    ),
                ),
            ),
        );
        add(
            "a time of many digits",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &format!(
                    r#"{{"traceId":"{}","spanId":"0000000000000001","startTimeUnixNano":"{}1"}}"#,
                    trace_id(0),
                    "0".repeat(room - 300)
                ),
            ),
        );
        add(
            "logs under a long scope name",
            Signal::Logs,
            format!(
                r#"{{"resourceLogs":[{{"scopeLogs":[{{"scope":{{"name":"{}"}},"logRecords":[{}]}}]}}]}}"#,
                "s".repeat(room / 2),
                fill(room / 2 - 100, |_| "{}".to_owned())
            )
            .into_bytes(),
        );
        add(
            "empty logs",
            Signal::Logs,
            logs(&fill(room, |_| "{}".to_owned())),
        );
        add(
            "ordinary logs",
            Signal::Logs,
            logs(&fill(room, |index| {
                format!(
                    r#"{{"timeUnixNano":"{}","severityText":"INFO","body":{{"stringValue":"request {index} handled"}},"traceId":"{}","attributes":[{{"key":"route","value":{{"stringValue":"/api/x"}}}},{{"key":"status","value":{{"intValue":"200"}}}}]}}"#,
                    now_ns() - 60_000_000_000,
                    trace_id(index / 10)
                )
            })),
        );
    }
    // Shapes sized so one allocation is the peak: a list of exactly 2^14 attributes is full when
    // the map is sorted, so the sort's scratch is the most decoding holds.
    let attributes = |value: &dyn Fn(usize) -> String| {
        traces(
            &service("svc"),
            "s",
            &span(
                0,
                0,
                &format!(
                    r#","attributes":[{}]"#,
                    (0..1 << 14)
                        .map(|index| format!(r#"{{"key":"{index:05x}"{}}}"#, value(index)))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
            ),
        )
    };
    shapes.push((
        "2^14 attributes".to_owned(),
        Signal::Traces,
        attributes(&|_| String::new()),
    ));
    shapes.push((
        "2^14 double attributes".to_owned(),
        Signal::Traces,
        attributes(&|index| format!(r#","value":{{"doubleValue":{index}.5}}"#)),
    ));
    shapes.push((
        "a key-value list of escaped keys".to_owned(),
        Signal::Traces,
        traces(
            &service("svc"),
            "s",
            &span(
                0,
                0,
                &format!(
                    r#","attributes":[{{"key":"a","value":{{"kvlistValue":{{"values":[{}]}}}}}}]"#,
                    (0..1 << 14)
                        .map(|index| format!(r#"{{"key":"k\n{index}"}}"#))
                        .collect::<Vec<_>>()
                        .join(",")
                ),
            ),
        ),
    ));
    shapes.push((
        "logs under a 256-byte scope name".to_owned(),
        Signal::Logs,
        format!(
            r#"{{"resourceLogs":[{{"scopeLogs":[{{"scope":{{"name":"{}"}},"logRecords":[{}]}}]}}]}}"#,
            "s".repeat(256),
            (0..2_000)
                .map(|index| format!(r#"{{"body":{{"stringValue":"log {index}"}}}}"#))
                .collect::<Vec<_>>()
                .join(",")
        )
        .into_bytes(),
    ));
    // The fifth-round reviewer's 29 shapes (`shapes/manifest.json`), made the same way.
    let one_log = |body: &str| logs(&format!(r#"{{"body":{body}}}"#));
    let fixed: Vec<(&str, Signal, Vec<u8>)> = vec![
        ("invalid boolValue ASCII", Signal::Logs, one_log(&format!(r#"{{"boolValue":"{}"}}"#, "x".repeat(900_000)))),
        ("invalid arrayValue ASCII", Signal::Logs, one_log(&format!(r#"{{"arrayValue":"{}"}}"#, "x".repeat(900_000)))),
        ("invalid kvlistValue ASCII", Signal::Logs, one_log(&format!(r#"{{"kvlistValue":"{}"}}"#, "x".repeat(900_000)))),
        ("invalid intValue ASCII", Signal::Logs, one_log(&format!(r#"{{"intValue":"{}"}}"#, "x".repeat(900_000)))),
        ("invalid doubleValue ASCII", Signal::Logs, one_log(&format!(r#"{{"doubleValue":"{}"}}"#, "x".repeat(900_000)))),
        ("invalid bool unprintable UTF8", Signal::Logs, one_log(&format!(r#"{{"boolValue":"{}"}}"#, "\u{80}".repeat(400_000)))),
        ("top-level ASCII string", Signal::Traces, format!(r#""{}""#, "x".repeat(900_000)).into_bytes()),
        ("log body null", Signal::Logs, one_log("null")),
        ("log body empty", Signal::Logs, one_log("{}")),
        ("log body true", Signal::Logs, one_log(r#"{"boolValue":true}"#)),
        ("log body false", Signal::Logs, one_log(r#"{"boolValue":false}"#)),
        ("log body smallest integer", Signal::Logs, one_log(r#"{"intValue":"-9223372036854775808"}"#)),
        ("log body NaN", Signal::Logs, one_log(r#"{"doubleValue":"NaN"}"#)),
        ("log body bytes", Signal::Logs, one_log(r#"{"bytesValue":"YQ=="}"#)),
        (
            "log body array of integers",
            Signal::Logs,
            one_log(&format!(
                r#"{{"arrayValue":{{"values":[{}]}}}}"#,
                (0..5_000).map(|index| format!(r#"{{"intValue":"{index}"}}"#)).collect::<Vec<_>>().join(",")
            )),
        ),
        ("log body escapes", Signal::Logs, one_log(&format!(r#"{{"stringValue":"{}"}}"#, r"\\\n\r\t\u0001😀".repeat(3_000)))),
        (
            "log body long distinct keys",
            Signal::Logs,
            one_log(&format!(
                r#"{{"kvlistValue":{{"values":[{}]}}}}"#,
                (0..4_500)
                    .map(|index| format!(r#"{{"key":"key-{index:05}-{}","value":{{"stringValue":"v"}}}}"#, "k".repeat(80)))
                    .collect::<Vec<_>>()
                    .join(",")
            )),
        ),
        (
            "duplicate keys distinct arrays",
            Signal::Logs,
            one_log(&format!(
                r#"{{"kvlistValue":{{"values":[{}]}}}}"#,
                (0..40)
                    .map(|repeat| format!(
                        r#"{{"key":"repeat","value":{{"arrayValue":{{"values":[{}]}}}}}}"#,
                        (0..1_000).map(|index| format!(r#"{{"intValue":"{}"}}"#, index + repeat)).collect::<Vec<_>>().join(",")
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )),
        ),
        (
            "many resources many scopes",
            Signal::Logs,
            format!(
                r#"{{"resourceLogs":[{}]}}"#,
                (0..1_500)
                    .map(|resource| format!(
                        r#"{{"resource":{{"attributes":[{{"key":"k{resource}","value":{{"stringValue":"{}"}}}}]}},"scopeLogs":[{{"scope":{{"name":"s{resource}"}},"logRecords":[{{"body":{{"stringValue":"msg"}}}},{{"body":{{"stringValue":"msg"}}}}]}},{{"scope":{{"name":"t{resource}"}},"logRecords":[{{"body":{{"stringValue":"msg"}}}}]}}]}}"#,
                        "v".repeat(32)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
            .into_bytes(),
        ),
        ("deep wide 8", Signal::Logs, one_log(&deep_wide(8))),
        ("deep wide 32", Signal::Logs, one_log(&deep_wide(32))),
        ("deep wide 63", Signal::Logs, one_log(&deep_wide(63))),
        (
            "escaped distinct long keys",
            Signal::Logs,
            one_log(&format!(
                r#"{{"kvlistValue":{{"values":[{}]}}}}"#,
                (0..5_000)
                    .map(|index| format!(r#"{{"key":"\n{index}{}","value":{{"intValue":"1"}}}}"#, "k".repeat(100)))
                    .collect::<Vec<_>>()
                    .join(",")
            )),
        ),
        (
            "huge array of booleans",
            Signal::Logs,
            one_log(&format!(r#"{{"arrayValue":{{"values":[{}]}}}}"#, vec![r#"{"boolValue":true}"#; 40_000].join(","))),
        ),
        ("million digit integer", Signal::Logs, one_log(&format!(r#"{{"intValue":"{}1"}}"#, "0".repeat(900_000)))),
        ("surrogate escape", Signal::Logs, one_log(r#"{"stringValue":"😀"}"#)),
        ("deep ignored arrays", Signal::Traces, format!(r#"{{"unknown":{}0{}}}"#, "[".repeat(450_000), "]".repeat(450_000)).into_bytes()),
        (
            "deep ignored arrays, a closing bracket in a string at each level",
            Signal::Traces,
            format!(r#"{{"unknown":{}0{}}}"#, r#"["]","#.repeat(200_000), "]".repeat(200_000)).into_bytes(),
        ),
        ("deep ignored object", Signal::Traces, format!(r#"{{"unknown":{}0{}}}"#, r#"{"x":"#.repeat(140_000), "}".repeat(140_000)).into_bytes()),
        (
            "duplicate wire names",
            Signal::Traces,
            br#"{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"00000000000000000000000000000001","spanId":"0000000000000001","name":"a","name":"b"}]}]}]}"#.to_vec(),
        ),
        (
            "an attribute value nesting a skipped field deeply",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(0, 0, &format!(r#","attributes":[{{"key":"a","value":{{"unknown":{}0{},"stringValue":"v"}}}}]"#, "[".repeat(400_000), "]".repeat(400_000))),
            ),
        ),
    ];
    // Many spans under one scope name as long as a name may be: each row keeps its own copy, so
    // the copies are charged. (The shared scope name above, at half the size, is now refused as
    // a name too long before its copies are made.)
    shapes.push((
        "many spans under a 4,096-byte scope name".to_owned(),
        Signal::Traces,
        traces(
            &service("svc"),
            &"s".repeat(otlp::NAME_BYTES),
            &fill(LIMIT - otlp::NAME_BYTES - 512, |index| {
                span(index, index, "")
            }),
        ),
    ));
    // Long numbers: serde_json collects their digits whether the number is valid or the wrong
    // kind for its field.
    let digits = "9".repeat(900_001);
    let with_span = |field: &str| {
        traces(
            &service("svc"),
            "s",
            &span(0, 0, "").replacen(r#""name":"op""#, &format!(r#""name":"op",{field}"#), 1),
        )
    };
    for (name, signal, body) in [
        (
            "a valid double of 900,001 digits",
            Signal::Logs,
            one_log(&format!(r#"{{"doubleValue":1.{}}}"#, "0".repeat(900_000))),
        ),
        (
            "a number of 900,001 digits where a boolean is expected",
            Signal::Logs,
            one_log(&format!(r#"{{"boolValue":{digits}}}"#)),
        ),
        (
            "a number of 900,001 digits where a string is expected",
            Signal::Logs,
            one_log(&format!(r#"{{"stringValue":{digits}}}"#)),
        ),
        (
            "an integer value of 900,001 digits",
            Signal::Logs,
            one_log(&format!(r#"{{"intValue":{digits}}}"#)),
        ),
        (
            "an overflowing timestamp of 900,001 digits",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &span(0, 0, "").replacen(
                    r#""startTimeUnixNano":""#,
                    &format!(r#""startTimeUnixNano":{digits},"x":""#),
                    1,
                ),
            ),
        ),
        (
            "an overflowing kind of 900,001 digits",
            Signal::Traces,
            with_span(&format!(r#""kind":{digits}"#)),
        ),
        (
            // The reviewer's shape: refused at its budget; stored, far past its allowance, with
            // the scope copies uncharged.
            "4,000 spans under one 4,096-byte scope name",
            Signal::Traces,
            traces(
                &service("svc"),
                &"s".repeat(otlp::NAME_BYTES),
                &(0..4_000)
                    .map(|index| span(index, index, ""))
                    .collect::<Vec<_>>()
                    .join(","),
            ),
        ),
    ] {
        shapes.push((name.to_owned(), signal, body));
    }
    for (name, signal, body) in fixed {
        shapes.push((name.to_owned(), signal, body));
    }
    shapes
}

/// The longest string in `body` with an escape in it, in bytes.
fn longest_escaped_string(body: &[u8]) -> usize {
    let (mut longest, mut start, mut escaped, mut inside, mut index) = (0, 0, false, false, 0);
    while index < body.len() {
        match (inside, body[index]) {
            (false, b'"') => {
                inside = true;
                start = index;
                escaped = false;
            }
            (true, b'\\') => {
                escaped = true;
                index += 1;
            }
            (true, b'"') => {
                inside = false;
                if escaped {
                    longest = longest.max(index - start);
                }
            }
            _ => {}
        }
        index += 1;
    }
    longest
}

/// The longest number in `body`, outside strings, in bytes: serde_json collects a long number's
/// digits into the same scratch it unescapes strings into.
fn longest_number(body: &[u8]) -> usize {
    let (mut longest, mut run, mut inside, mut escaped) = (0, 0, false, false);
    for &byte in body {
        if inside {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => inside = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-' => {
                run += 1;
                longest = longest.max(run);
            }
            b'"' => {
                inside = true;
                run = 0;
            }
            _ => run = 0,
        }
    }
    longest
}

enum Decoded {
    Spans(Spans),
    Logs(Logs),
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let path = support::directory("memory", name);
        Scratch(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A query route, as a reader runs it.
type Route<'a> = dyn Fn(
        &Connection,
        &mut executor_collector::readers::Out,
    ) -> Result<(), executor_collector::readers::Stop>
    + 'a;

/// The largest answer of the routes a viewer calls on what the shape stored.
fn answer_peak(connection: &mut Connection) -> usize {
    let mut peak = 0;
    let search = Query::parse(Some("lookback=1d&limit=500"));
    let trace = trace_id(0);
    let routes: [&Route<'_>; 5] = [
        &|c, out| query::trace(c, out, &trace),
        &|c, out| query::trace_spans(c, out, &trace),
        &|c, out| query::search_spans(c, out, &search),
        &|c, out| query::traces(c, out, &search),
        &|c, out| {
            query::logs(
                c,
                out,
                LogFilter {
                    query: &search,
                    trace: None,
                },
            )
        },
    ];
    for route in routes {
        let (answered, held) = measure(|| answer_length(connection, route));
        let (status, _) = answered.expect("answers");
        assert!(status.is_success() || status.as_u16() == 404, "{status}");
        peak = peak.max(held);
    }
    peak
}

/// Decode, store and answer each shape at `limit`; the table of what each held, and any shape
/// that held more than its allowance.
fn check(limit: usize, shapes: Vec<(String, Signal, Vec<u8>)>) -> (Vec<String>, Vec<String>) {
    let budget = DECODE_SHARE * limit;
    let writer_allowed = memory::writer_bytes(limit);
    let reader_allowed = memory::reader_bytes(limit);
    let mut table = vec![format!(
        "| Shape | Body | Decoding: charged / allowed / measured | Writer: measured (allowed {writer_allowed}) | Reader: measured (allowed {reader_allowed}) |\n| --- | ---: | --- | ---: | ---: |"
    )];
    let mut failures = Vec::new();
    for (name, signal, body) in shapes {
        // serde_json has one scratch buffer, kept for the reader's life, into which it unescapes
        // a string (twice its length while it grows) and collects the digits of a long number,
        // valid or about to be refused as the wrong kind (growing by doubling: the old buffer
        // beside one up to twice the digits, three times them in all).
        let uncharged =
            UNCHARGED_BYTES + (2 * longest_escaped_string(&body)).max(3 * longest_number(&body));
        let ((decoded, charged), held) = measure(|| match signal {
            Signal::Traces => {
                let (result, charged) = otlp::decode_spans_charged(&body, limit);
                (result.map(Decoded::Spans), charged)
            }
            Signal::Logs => {
                let (result, charged) = otlp::decode_logs_charged(&body, limit);
                (result.map(Decoded::Logs), charged)
            }
        });
        let allowed = charged.min(budget) + uncharged;
        if held > allowed {
            failures.push(format!(
                "{name}: decoding held {held} bytes, allowed {allowed}"
            ));
        }
        let (outcome, writer, reader) = match decoded {
            Err(Undecodable::TooLarge) => ("refused: too large".to_owned(), None, None),
            Err(Undecodable::Invalid(invalid)) => {
                if invalid.0.len() > MESSAGE_BYTES {
                    failures.push(format!("{name}: a message of {} bytes", invalid.0.len()));
                }
                (
                    format!("refused: {} byte message", invalid.0.len()),
                    None,
                    None,
                )
            }
            Ok(decoded) => {
                let scratch = Scratch::new("store");
                let database = store::database_path(&scratch.0);
                let mut connection = store::open(&database).expect("opens");
                let (stored, writer) = measure(|| match &decoded {
                    Decoded::Spans(spans) => store::store_spans_at(&mut connection, spans, 1),
                    Decoded::Logs(logs) => store::store_logs_at(&mut connection, logs, 1),
                });
                stored.expect("stores");
                drop(decoded);
                if writer > writer_allowed {
                    failures.push(format!("{name}: the writer held {writer} bytes"));
                }
                drop(connection);
                let mut reader_connection = Connection::open(&database).expect("opens");
                let reader = answer_peak(&mut reader_connection);
                if reader > reader_allowed {
                    failures.push(format!("{name}: a reader held {reader} bytes"));
                }
                ("stored".to_owned(), Some(writer), Some(reader))
            }
        };
        let show = |value: Option<usize>| value.map_or("—".to_owned(), |value| value.to_string());
        table.push(format!(
            "| {name} | {} | {charged} / {allowed} / {held}, {outcome} | {} | {} |",
            body.len(),
            show(writer),
            show(reader)
        ));
    }
    (table, failures)
}

/// Each of `names` was stored, by the table `check` made: exports the decoder once refused while
/// they fit its budget.
fn stored(table: &[String], names: &[&str], failures: &mut Vec<String>) {
    for name in names {
        let row = table
            .iter()
            .find(|row| row.starts_with(&format!("| {name} |")));
        if !row.is_some_and(|row| row.contains(", stored |")) {
            failures.push(format!("{name} was not stored: {row:?}"));
        }
    }
}

#[test]
fn decoding_storing_and_answering_hold_no_more_than_their_limits_allow() {
    let _alone = alone();
    let mut shapes = corpus();
    // 12,000 short logs in 348 KB, the reviewer's admission case: refused in round four, stored
    // since.
    shapes.push((
        "12,000 short logs".to_owned(),
        Signal::Logs,
        format!(
            r#"{{"resourceLogs":[{{"scopeLogs":[{{"scope":{{"name":""}},"logRecords":[{}]}}]}}]}}"#,
            vec![r#"{"body":{"stringValue":"x"}}"#; 12_000].join(",")
        )
        .into_bytes(),
    ));
    let (table, mut failures) = check(LIMIT, shapes);
    stored(&table, &["12,000 short logs"], &mut failures);
    eprintln!("{}", table.join("\n"));
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The densest exports at the default size limit: rows reserved exactly from each list's length
/// hold no more than they are charged for, whether admitted or refused. (The gzip cases decode the
/// same bodies once inflated; inflating is bounded by the limit before decoding starts.)
#[test]
fn the_densest_exports_at_the_default_limit_hold_what_they_are_charged() {
    let _alone = alone();
    let records = |record: &str, count: usize| logs(&vec![record; count].join(","));
    let shapes = vec![
        ("524,289 empty logs".to_owned(), Signal::Logs, records("{}", 524_289)),
        (
            "262,145 INFO text logs".to_owned(),
            Signal::Logs,
            records(r#"{"severityText":"INFO","body":{"stringValue":"ok"}}"#, 262_145),
        ),
        (
            "200,000 logs under a 256-byte scope name".to_owned(),
            Signal::Logs,
            format!(
                r#"{{"resourceLogs":[{{"scopeLogs":[{{"scope":{{"name":"{}"}},"logRecords":[{}]}}]}}]}}"#,
                "s".repeat(256),
                vec![r#"{"body":{"stringValue":"event"}}"#; 200_000].join(",")
            )
            .into_bytes(),
        ),
        (
            "an array of 800,001 booleans".to_owned(),
            Signal::Logs,
            records(
                &format!(
                    r#"{{"body":{{"arrayValue":{{"values":[{}]}}}}}}"#,
                    vec![r#"{"boolValue":true}"#; 800_001].join(",")
                ),
                1,
            ),
        ),
        (
            "15 MiB invalid boolean".to_owned(),
            Signal::Logs,
            records(&format!(r#"{{"body":{{"boolValue":"{}"}}}}"#, "x".repeat(15 << 20)), 1),
        ),
        (
            "15 MiB text body".to_owned(),
            Signal::Logs,
            records(&format!(r#"{{"body":{{"stringValue":"{}"}}}}"#, "x".repeat(15 << 20)), 1),
        ),
        (
            "7 Mi invalid boolean of U+0080".to_owned(),
            Signal::Logs,
            records(&format!(r#"{{"body":{{"boolValue":"{}"}}}}"#, "\u{80}".repeat(7 << 20)), 1),
        ),
    ];
    let (table, mut failures) = check(16 << 20, shapes);
    // Refused while its wire list grew by doubling: the old allocation beside one twice its size.
    stored(&table, &["262,145 INFO text logs"], &mut failures);
    eprintln!("{}", table.join("\n"));
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The writer holds fixed-size state for each trace an export touches, whatever the traces'
/// stored names: an export of one small span for each of 3,000 traces whose stored root names
/// are as long as a name may be (4 KiB), and an export of 3,000 root spans sharing one such
/// service name, are each
/// stored within the writer's allowance and within a few MiB of SQLite's page cache. (The writer
/// once loaded every touched trace's names and copied the service name into each: 2.3 GiB for
/// one export.)
#[test]
fn the_writer_holds_fixed_state_for_each_trace_it_touches() {
    let _alone = alone();
    let scratch = Scratch::new("writer-traces");
    let database = store::database_path(&scratch.0);
    let mut connection = store::open(&database).expect("opens");
    let traces_count = 3_000;
    let long = "r".repeat(otlp::NAME_BYTES);
    for first in (0..traces_count).step_by(30) {
        let spans: Vec<String> = (first..first + 30)
            .map(|trace| {
                span(trace, trace, "").replacen(r#""name":"op""#, &format!(r#""name":"{long}""#), 1)
            })
            .collect();
        let (decoded, _) =
            otlp::decode_spans_charged(&traces(&service("svc"), "s", &spans.join(",")), 16 << 20);
        store::store_spans_at(&mut connection, &decoded.expect("decodes"), 1).expect("stores");
    }
    let children: Vec<String> = (0..traces_count)
        .map(|trace| {
            span(trace, 100_000 + trace, "").replacen(
                r#""name":"op""#,
                r#""name":"child","parentSpanId":"0000000000000001""#,
                1,
            )
        })
        .collect();
    let (decoded, _) =
        otlp::decode_spans_charged(&traces(&service("svc"), "s", &children.join(",")), LIMIT);
    let decoded = decoded.expect("decodes");
    let (stored, held) = measure(|| store::store_spans_at(&mut connection, &decoded, 2));
    stored.expect("stores");
    let allowed = memory::writer_bytes(LIMIT);
    eprintln!(
        "small updates to {traces_count} traces with long names: {held} bytes (allowed {allowed})"
    );
    assert!(
        held < allowed,
        "the writer held {held} bytes, allowed {allowed}"
    );
    assert!(
        held < traces_count * long.len() / 4,
        "the writer held the stored names: {held} bytes"
    );

    let shared = Scratch::new("writer-service");
    let mut connection = store::open(&store::database_path(&shared.0)).expect("opens");
    let roots: Vec<String> = (0..3_000).map(|trace| span(trace, trace, "")).collect();
    let (decoded, _) = otlp::decode_spans_charged(
        &traces(
            &service(&"n".repeat(otlp::NAME_BYTES)),
            "s",
            &roots.join(","),
        ),
        LIMIT,
    );
    let decoded = decoded.expect("decodes");
    let (stored, held) = measure(|| store::store_spans_at(&mut connection, &decoded, 1));
    stored.expect("stores");
    eprintln!("3,000 traces sharing a 4 KiB service name: {held} bytes (allowed {allowed})");
    assert!(
        held < allowed,
        "the writer held {held} bytes, allowed {allowed}"
    );
    assert!(
        held < 3_000 * otlp::NAME_BYTES / 4,
        "the writer copied the service name: {held} bytes"
    );
}

/// The ceilings `memory` derives, at the default size limit, 8 MiB and 4 MiB, for the README.
#[test]
fn the_ceilings_at_three_limits() {
    for limit in [16usize << 20, 8 << 20, 4 << 20] {
        let mib = |bytes: usize| bytes as f64 / (1 << 20) as f64;
        eprintln!(
            "limit {} MiB: export {:.1} MiB, reader {:.1} MiB, writer {:.1} MiB, all {:.1} MiB",
            limit >> 20,
            mib(memory::export_bytes(limit)),
            mib(memory::reader_bytes(limit)),
            mib(memory::writer_bytes(limit)),
            mib(memory::ceiling_bytes(limit, 4))
        );
    }
}

/// What the data directory holds: the store, its write-ahead log and the log's index.
fn directory_bytes(path: &std::path::Path) -> u64 {
    std::fs::read_dir(path)
        .expect("lists")
        .map(|entry| entry.expect("entry").metadata().expect("metadata").len())
        .sum()
}

/// The shapes that write the most to disk for their size or for their decode charge, each
/// filling about `budget` bytes.
fn disk_shapes(budget: usize) -> Vec<(&'static str, Signal, Vec<u8>)> {
    let name = |letter: &str| letter.repeat(otlp::NAME_BYTES);
    let distinct = |index: usize, letter: &str| format!("{index:08x}{}", &name(letter)[8..]);
    let resources = |resource: &dyn Fn(usize) -> String| {
        format!(
            r#"{{"resourceSpans":[{}]}}"#,
            fill(budget, |index| format!(
                r#"{{"resource":{{"attributes":[{}]}},"scopeSpans":[{{"spans":[{}]}}]}}"#,
                resource(index),
                span(index, index, "")
            ))
        )
        .into_bytes()
    };
    let spans = |extra: &dyn Fn(usize) -> String| {
        traces(
            &service("svc"),
            "s",
            &fill(budget, |index| span(index, index, &extra(index))),
        )
    };
    let renamed = |index: usize, to: &str| {
        span(index, index, "").replacen(r#""name":"op""#, &format!(r#""name":"{to}""#), 1)
    };
    let keys: String = (0..20)
        .map(|key| {
            format!(
                r#"{{"key":"{}","value":{{"stringValue":"v"}}}}"#,
                distinct(key, "k")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    vec![
        (
            // The reviewers' counterexamples to a bound derived from the decode charge: a record
            // of about 2 KiB takes a whole page, in `spans` and again in `traces`; and index
            // records just under the 1,002 bytes SQLite keeps in a page, with their headers,
            // take overflow pages.
            "one span in each trace, its name 2,010 bytes",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &fill(budget, |index| renamed(index, &"n".repeat(2010))),
            ),
        ),
        (
            "a resource for each span, each its attributes 1,000 bytes",
            Signal::Traces,
            resources(&|index| {
                format!(
                    r#"{{"key":"x","value":{{"stringValue":"{index:08x}{}"}}}}"#,
                    "v".repeat(984)
                )
            }),
        ),
        (
            "a resource for each span, each its own 997-byte service name",
            Signal::Traces,
            resources(&|index| service(&format!("{index:08x}{}", "u".repeat(989)))),
        ),
        (
            "one short span in each trace",
            Signal::Traces,
            spans(&|_| String::new()),
        ),
        (
            "one span in each trace, its name 4 KiB",
            Signal::Traces,
            traces(
                &service("svc"),
                "s",
                &fill(budget, |index| renamed(index, &name("n"))),
            ),
        ),
        (
            "a resource for each span, each its own 4 KiB service name",
            Signal::Traces,
            resources(&|index| service(&distinct(index, "v"))),
        ),
        (
            "a resource for each span, each its own 1,010-byte service name",
            Signal::Traces,
            resources(&|index| service(&format!("{index:08x}{}", "w".repeat(1_002)))),
        ),
        (
            "a resource for each span, each its own 990-byte service name",
            Signal::Traces,
            resources(&|index| service(&format!("{index:08x}{}", "w".repeat(982)))),
        ),
        (
            "a resource for each span, each a 4 KiB attribute",
            Signal::Traces,
            resources(&|index| {
                format!(
                    r#"{{"key":"big","value":{{"stringValue":"{}"}}}}"#,
                    distinct(index, "b")
                )
            }),
        ),
        (
            "one span in each trace, all sharing one 4 KiB service name",
            Signal::Traces,
            traces(
                &service(&name("v")),
                "s",
                &fill(budget, |index| span(index, index, "")),
            ),
        ),
        (
            "a scope for each span, its name 4 KiB",
            Signal::Traces,
            format!(
                r#"{{"resourceSpans":[{{"resource":{{"attributes":[{}]}},"scopeSpans":[{}]}}]}}"#,
                service("svc"),
                fill(budget, |index| format!(
                    r#"{{"scope":{{"name":"{}"}},"spans":[{}]}}"#,
                    name("s"),
                    span(index, index, "")
                ))
            )
            .into_bytes(),
        ),
        (
            "spans with twenty 4 KiB keys",
            Signal::Traces,
            spans(&|_| format!(r#","attributes":[{keys}]"#)),
        ),
        (
            "spans of 128 events with 4 KiB names",
            Signal::Traces,
            spans(&|_| {
                format!(
                    r#","events":[{}]"#,
                    vec![format!(r#"{{"name":"{}"}}"#, name("e")); 128].join(",")
                )
            }),
        ),
        (
            "spans with many short attributes",
            Signal::Traces,
            spans(&|_| {
                let attributes: Vec<String> = (0..50)
                    .map(|key| format!(r#"{{"key":"{key}","value":{{"intValue":"1"}}}}"#))
                    .collect();
                format!(r#","attributes":[{}]"#, attributes.join(","))
            }),
        ),
        (
            "one log of one long body",
            Signal::Logs,
            logs(&format!(
                r#"{{"body":{{"stringValue":"{}"}}}}"#,
                "x".repeat(budget.saturating_sub(512))
            )),
        ),
        (
            "short INFO logs",
            Signal::Logs,
            logs(&fill(budget, |_| {
                r#"{"severityText":"INFO","body":{"stringValue":"ok"}}"#.to_owned()
            })),
        ),
        (
            "empty logs",
            Signal::Logs,
            logs(&fill(budget, |_| "{}".to_owned())),
        ),
        (
            "logs with twenty 4 KiB keys",
            Signal::Logs,
            logs(&fill(budget, |_| format!(r#"{{"attributes":[{keys}]}}"#))),
        ),
        (
            "logs each in its own trace",
            Signal::Logs,
            logs(&fill(budget, |index| {
                format!(
                    r#"{{"traceId":"{}","spanId":"0000000000000001"}}"#,
                    trace_id(index)
                )
            })),
        ),
    ]
}

/// The pages in use and free that make up a store, and its write-ahead log's size.
fn sizes(connection: &Connection, database: &std::path::Path) -> (u64, u64) {
    let pages: i64 = connection
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .expect("pages");
    let page: i64 = connection
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .expect("page size");
    let log = std::fs::metadata(format!("{}-wal", database.display())).map_or(0, |m| m.len());
    ((pages * page) as u64, log)
}

/// What one export writes: the writer measures it as it stores the export and refuses one that
/// grows the database or the log past `store::WriteLimit` (20 times the limit each), so the bound
/// is enforced, not derived. Each shape, as large as decoding admits under 1, 4 and 16 MiB, is
/// stored within the limit or refused; a stored one grew the database and the log by no more than
/// their limits (the log by one commit frame more). The stores are under `target/tmp`, as the
/// largest files pass 100 MB.
#[test]
fn one_export_writes_no_more_than_its_enforced_limit() {
    let _alone = alone();
    let mut table = vec![
        "| Limit | Shape | Body | Charged | Database grew | Log grew | Directory at its peak | Outcome |\n| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |"
            .to_owned(),
    ];
    let mut failures = Vec::new();
    for limit in [1usize << 20, 4 << 20, 16 << 20] {
        let write_limit = store::WriteLimit::for_export_limit(limit);
        for shape in 0..disk_shapes(1_000).len() {
            // The largest body of the shape the decoder admits at `limit`.
            let mut budget = limit - 1024;
            let (name, body, decoded, charged) = loop {
                let (name, signal, body) = disk_shapes(budget).swap_remove(shape);
                let (decoded, charged) = match signal {
                    Signal::Traces => {
                        let (decoded, charged) = otlp::decode_spans_charged(&body, limit);
                        (decoded.map(Decoded::Spans), charged)
                    }
                    Signal::Logs => {
                        let (decoded, charged) = otlp::decode_logs_charged(&body, limit);
                        (decoded.map(Decoded::Logs), charged)
                    }
                };
                match decoded {
                    Ok(decoded) => break (name, body, decoded, charged),
                    Err(Undecodable::TooLarge) => budget = budget * 7 / 8,
                    Err(Undecodable::Invalid(invalid)) => panic!("{name}: {}", invalid.0),
                }
            };
            let scratch = support::large_directory("memory", "disk");
            let database = store::database_path(&scratch);
            let mut connection = store::open(&database).expect("opens");
            let (database_before, log_before) = sizes(&connection, &database);
            let stored = match &decoded {
                Decoded::Spans(spans) => {
                    store::store_spans_within(&mut connection, spans, 1, write_limit)
                }
                Decoded::Logs(logs) => {
                    store::store_logs_within(&mut connection, logs, 1, write_limit)
                }
            };
            drop(decoded);
            let peak = directory_bytes(&scratch);
            let (database_after, log_after) = sizes(&connection, &database);
            let (database_grew, log_grew) = (
                database_after.saturating_sub(database_before),
                log_after.saturating_sub(log_before),
            );
            let outcome = match stored {
                Ok(_) => {
                    if database_grew > write_limit.database_bytes {
                        failures.push(format!(
                            "{name} at {limit}: stored, the database grew {database_grew} bytes"
                        ));
                    }
                    // The commit's own frame is written after the last measurement.
                    if log_grew > write_limit.log_bytes + 4096 + 24 {
                        failures.push(format!(
                            "{name} at {limit}: stored, the log grew {log_grew} bytes"
                        ));
                    }
                    "stored".to_owned()
                }
                Err(store::StoreError::TooMuchDisk { .. }) => {
                    let spans: i64 = connection
                        .query_row("SELECT count(*) FROM spans", [], |row| row.get(0))
                        .expect("count");
                    let logs: i64 = connection
                        .query_row("SELECT count(*) FROM logs", [], |row| row.get(0))
                        .expect("count");
                    if spans + logs != 0 {
                        failures.push(format!("{name} at {limit}: refused, but rows were kept"));
                    }
                    "refused: too much disk".to_owned()
                }
                Err(error) => panic!("{name}: {error}"),
            };
            drop(connection);
            let _ = std::fs::remove_dir_all(&scratch);
            let mb = |bytes: u64| format!("{:.1} MB", bytes as f64 / 1e6);
            table.push(format!(
                "| {} MiB | {name} | {} | {} | {} | {} | {} | {outcome} |",
                limit >> 20,
                body.len(),
                mb(charged as u64),
                mb(database_grew),
                mb(log_grew),
                mb(peak),
            ));
        }
    }
    eprintln!("{}", table.join("\n"));
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// An export that changes one small row on each of many existing pages grows the log by a page
/// or more for each row it touches, without growing the database: no decode charge sees that.
/// A store of 96,000 traces of one span each, then one export under 1 MiB re-sending every 16th
/// span with a new end: stored without a limit, it grows the log past the 20 MiB one export may
/// add at 1 MiB; with the writer's limit it is refused, and the store keeps every row it had.
#[test]
fn an_export_touching_many_pages_is_held_to_its_log_limit() {
    let _alone = alone();
    let scratch = support::large_directory("memory", "many-pages");
    let database = store::database_path(&scratch);
    let mut connection = store::open(&database).expect("opens");
    let traces_count = 96_000;
    let export = |first: usize, every: usize, count: usize, end: u64| {
        let start = now_ns() - 60_000_000_000;
        traces(
            &service("svc"),
            "s",
            &(0..count)
                .map(|index| {
                    let trace = first + index * every;
                    format!(
                        r#"{{"traceId":"{}","spanId":"{:016x}","name":"op","startTimeUnixNano":"{start}","endTimeUnixNano":"{}"}}"#,
                        trace_id(trace),
                        trace + 1,
                        start + end
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
        )
    };
    for first in (0..traces_count).step_by(4_000) {
        let (decoded, _) = otlp::decode_spans_charged(&export(first, 1, 4_000, 1_000), 16 << 20);
        store::store_spans_at(&mut connection, &decoded.expect("decodes"), 1).expect("stores");
    }
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .expect("checkpoints");
    let body = export(0, 16, traces_count / 16, 2_000);
    assert!(body.len() <= LIMIT, "{} bytes", body.len());
    let (decoded, charged) = otlp::decode_spans_charged(&body, LIMIT);
    let decoded = decoded.expect("decodes");
    let limit = store::WriteLimit::for_export_limit(LIMIT);
    // Without a limit, on a copy of the store.
    let copy = support::large_directory("memory", "many-pages-copy");
    drop(connection);
    std::fs::copy(&database, store::database_path(&copy)).expect("copies");
    let mut unlimited = store::open(&store::database_path(&copy)).expect("opens");
    let (database_before, log_before) = sizes(&unlimited, &store::database_path(&copy));
    store::store_spans_at(&mut unlimited, &decoded, 2).expect("stores");
    let (database_after, log_after) = sizes(&unlimited, &store::database_path(&copy));
    eprintln!(
        "{} spans in {} bytes (charged {charged}): without a limit the database grew {} bytes and the log {} bytes",
        traces_count / 16,
        body.len(),
        database_after - database_before,
        log_after - log_before
    );
    assert!(
        log_after - log_before > limit.log_bytes,
        "the shape no longer writes past the limit: {} bytes",
        log_after - log_before
    );
    drop(unlimited);
    let _ = std::fs::remove_dir_all(&copy);
    // With the writer's limit.
    let mut connection = store::open(&database).expect("opens");
    let ends = |connection: &Connection| -> i64 {
        connection
            .query_row("SELECT sum(end_ns % 1000000) FROM spans", [], |row| {
                row.get(0)
            })
            .expect("sum")
    };
    let before = ends(&connection);
    let (_, log_before) = sizes(&connection, &database);
    let refused = store::store_spans_within(&mut connection, &decoded, 2, limit);
    let (_, log_after) = sizes(&connection, &database);
    eprintln!(
        "with the limit: {refused:?}; the log file grew {} bytes",
        log_after.saturating_sub(log_before)
    );
    assert!(matches!(
        refused,
        Err(store::StoreError::TooMuchDisk { .. })
    ));
    assert_eq!(ends(&connection), before, "a refused export changed rows");
    let spans: i64 = connection
        .query_row("SELECT count(*) FROM spans", [], |row| row.get(0))
        .expect("count");
    assert_eq!(spans, traces_count as i64);
    drop(connection);
    let _ = std::fs::remove_dir_all(&scratch);
}
