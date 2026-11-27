//! The store: resent and changed spans, trace summaries, resource references, that an export is
//! all or nothing, and creating a new file. `retention.rs` covers a file of another format or
//! application. `process.rs` interrupts a real first start.

mod support;

use std::path::PathBuf;

use executor_collector::otlp::{decode_logs, decode_spans};
use executor_collector::store::{self, FORMAT, store_logs, store_spans};
use rusqlite::Connection;
use serde_json::{Value, json};

const TRACE: &str = "0af7651916cd43dd8448eb211c80319c";
const ROOT: &str = "b7ad6b7169203331";
const CHILD: &str = "00f067aa0ba902b7";

/// A directory removed when the test ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = support::directory("test", name);
        Scratch(path)
    }

    fn database(&self) -> PathBuf {
        self.0.join("telemetry.sqlite")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A span of `TRACE`; `start` and `end` in milliseconds after `EPOCH_NS`, an `end` of 0 for none.
fn span(id: &str, parent: &str, name: &str, start: u64, end: u64) -> Value {
    span_ns(
        id,
        parent,
        name,
        EPOCH_NS + start * 1_000_000,
        if end == 0 {
            0
        } else {
            EPOCH_NS + end * 1_000_000
        },
    )
}

/// 2023-11-14, so every time here is a real one: Motel and the collector decide whether a span
/// is running from whole milliseconds.
const EPOCH_NS: u64 = 1_700_000_000_000_000_000;

fn span_ns(id: &str, parent: &str, name: &str, start: u64, end: u64) -> Value {
    json!({ "traceId": TRACE, "spanId": id, "parentSpanId": parent, "name": name,
            "startTimeUnixNano": start.to_string(), "endTimeUnixNano": end.to_string(),
            "attributes": [{ "key": "k", "value": { "stringValue": "v" } }] })
}

fn export(service: &str, spans: Vec<Value>) -> executor_collector::otlp::Spans {
    let body = json!({ "resourceSpans": [{
        "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": service } }] },
        "scopeSpans": [{ "scope": { "name": "s" }, "spans": spans }],
    }] });
    decode_spans(body.to_string().as_bytes()).expect("decodes")
}

fn count(connection: &Connection, sql: &str) -> i64 {
    connection
        .query_row(sql, [], |row| row.get(0))
        .expect("query")
}

/// Every column of every span, trace and resource, to compare a store before and after.
fn snapshot(connection: &Connection) -> Vec<String> {
    let mut rows = Vec::new();
    for sql in [
        "SELECT id, hex(trace), hex(span_id), hex(parent_span_id), resource, scope_name, name, kind, start_ns, end_ns, status, attributes_json, events_json FROM spans ORDER BY id",
        "SELECT id, hex(trace_id), (SELECT name FROM services WHERE id = traces.service), root_name, root_started_ns, started_ns, ended_ns, last_seen_ms, span_count, error_count, running_count FROM traces ORDER BY id",
        "SELECT id, attributes_json, service_name FROM resources ORDER BY id",
    ] {
        let mut statement = connection.prepare(sql).expect("prepare");
        let columns = statement.column_count();
        let mut query = statement.query([]).expect("query");
        while let Some(row) = query.next().expect("row") {
            let values: Vec<String> = (0..columns)
                .map(|index| format!("{:?}", row.get_ref(index).expect("value")))
                .collect();
            rows.push(values.join("|"));
        }
    }
    rows
}

#[test]
fn an_unchanged_resend_is_counted_and_writes_nothing() {
    let scratch = Scratch::new("resend");
    let mut connection = store::open(&scratch.database()).expect("opens");
    let spans = || {
        export(
            "svc",
            vec![
                span(ROOT, "", "root", 1_000, 5_000),
                span(CHILD, ROOT, "child", 2_000, 3_000),
            ],
        )
    };
    assert_eq!(store_spans(&mut connection, &spans()).expect("stores"), 2);
    let before = snapshot(&connection);
    let changes = connection.total_changes();
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert_eq!(store_spans(&mut connection, &spans()).expect("stores"), 2);
    assert_eq!(connection.total_changes(), changes, "a resend wrote rows");
    assert_eq!(
        snapshot(&connection),
        before,
        "a resend changed the trace's last-seen time or a row"
    );
}

#[test]
fn a_changed_span_replaces_the_stored_one() {
    let scratch = Scratch::new("replace");
    let mut connection = store::open(&scratch.database()).expect("opens");
    store_spans(
        &mut connection,
        &export(
            "svc",
            vec![
                span(ROOT, "", "root", 1_000, 5_000),
                span(CHILD, ROOT, "child", 2_000, 3_000),
            ],
        ),
    )
    .expect("stores");
    let mut changed = span(CHILD, ROOT, "renamed", 2_000, 3_000);
    changed["attributes"] = json!([{ "key": "k", "value": { "stringValue": "w" } }]);
    changed["status"] = json!({ "code": 2 });
    assert_eq!(
        store_spans(&mut connection, &export("svc", vec![changed])).expect("stores"),
        1
    );
    assert_eq!(count(&connection, "SELECT count(*) FROM spans"), 2);
    let (name, attributes, status): (String, String, i64) = connection
        .query_row(
            "SELECT name, attributes_json, status FROM spans WHERE span_id = x'00f067aa0ba902b7'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("child");
    assert_eq!(
        (name.as_str(), attributes.as_str(), status),
        ("renamed", r#"{"k":"w"}"#, 1)
    );
    assert_eq!(count(&connection, "SELECT error_count FROM traces"), 1);
}

#[test]
fn a_span_listed_twice_in_one_export_is_stored_once_with_its_last_copy() {
    let scratch = Scratch::new("twice");
    let mut connection = store::open(&scratch.database()).expect("opens");
    let stored = store_spans(
        &mut connection,
        &export(
            "svc",
            vec![
                span(ROOT, "", "first", 1_000, 2_000),
                span(ROOT, "", "second", 1_000, 2_000),
            ],
        ),
    )
    .expect("stores");
    assert_eq!(stored, 2);
    assert_eq!(count(&connection, "SELECT count(*) FROM spans"), 1);
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM spans WHERE name = 'second'"
        ),
        1
    );
    assert_eq!(count(&connection, "SELECT span_count FROM traces"), 1);
}

#[test]
fn the_summary_kept_as_spans_arrive_matches_one_read_from_all_spans() {
    let scratch = Scratch::new("summary");
    let mut connection = store::open(&scratch.database()).expect("opens");
    // A child first, then a late root that started earlier, then a running span, spread over
    // three exports and two services.
    store_spans(
        &mut connection,
        &export("worker", vec![span(CHILD, ROOT, "child", 2_000, 3_000)]),
    )
    .expect("stores");
    assert_eq!(
        connection
            .query_row("SELECT (SELECT name FROM services WHERE id = traces.service), root_name FROM traces", [], |row| Ok(
                (row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)
            ))
            .expect("trace"),
        // Until a root arrives, the earliest span stands for it.
        ("worker".to_owned(), Some("child".to_owned()))
    );
    store_spans(
        &mut connection,
        &export("api", vec![span(ROOT, "", "root", 1_000, 9_000)]),
    )
    .expect("stores");
    store_spans(
        &mut connection,
        &export(
            "worker",
            vec![span("1111111111111111", ROOT, "open", 4_000, 0)],
        ),
    )
    .expect("stores");
    let kept: (String, Option<String>, i64, i64, i64, i64, i64) = connection
        .query_row("SELECT (SELECT name FROM services WHERE id = traces.service), root_name, started_ns, ended_ns, span_count, error_count, running_count FROM traces", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
        })
        .expect("trace");
    let at = |ms: i64| EPOCH_NS as i64 + ms * 1_000_000;
    assert_eq!(
        kept,
        (
            "api".to_owned(),
            Some("root".to_owned()),
            at(1_000),
            at(9_000),
            3,
            0,
            1
        )
    );
    // Replacing a span recomputes the summary from all spans; it must agree.
    let mut replaced = span(CHILD, ROOT, "child", 2_000, 3_000);
    replaced["attributes"] = json!([]);
    store_spans(&mut connection, &export("worker", vec![replaced])).expect("stores");
    let recomputed: (String, Option<String>, i64, i64, i64, i64, i64) = connection
        .query_row("SELECT (SELECT name FROM services WHERE id = traces.service), root_name, started_ns, ended_ns, span_count, error_count, running_count FROM traces", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
        })
        .expect("trace");
    assert_eq!(recomputed, kept);
}

#[test]
fn a_span_that_ends_before_it_starts_within_one_millisecond_has_ended() {
    let scratch = Scratch::new("submillisecond");
    let mut connection = store::open(&scratch.database()).expect("opens");
    // Motel compared whole milliseconds: this span ended (at 0 ms long), it is not running.
    let start = EPOCH_NS + 900;
    store_spans(
        &mut connection,
        &export(
            "api",
            vec![span_ns(ROOT, "", "root", start, EPOCH_NS + 100)],
        ),
    )
    .expect("stores");
    assert_eq!(count(&connection, "SELECT running_count FROM traces"), 0);
    // A replacement recomputes the summary from all spans, with the same rule.
    store_spans(
        &mut connection,
        &export(
            "api",
            vec![span_ns(ROOT, "", "renamed", start, EPOCH_NS + 100)],
        ),
    )
    .expect("stores");
    assert_eq!(count(&connection, "SELECT running_count FROM traces"), 0);
    assert_eq!(stored_summary(&connection), summary_from_spans(&connection));
}

/// The trace's summary as `recompute_summary` would give it, written out independently.
fn summary_from_spans(
    connection: &Connection,
) -> (String, Option<String>, i64, i64, i64, i64, i64) {
    let (spans, errors, running, started, ended): (i64, i64, i64, i64, i64) = connection
        .query_row(
            // Motel's rule: running when the end, in whole milliseconds, is 0 or before the start.
            "SELECT count(*), sum(status), sum(end_ns / 1000000 <= 0 OR end_ns / 1000000 < start_ns / 1000000), min(start_ns), max(end_ns) FROM spans",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .expect("aggregate");
    let first = |filter: &str| -> Option<(String, String)> {
        connection
            .query_row(
                &format!(
                    "SELECT spans.name, resources.service_name FROM spans JOIN resources ON resources.id = spans.resource
                     {filter} ORDER BY spans.start_ns, spans.id LIMIT 1"
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
    };
    let (root, service) = match first("WHERE spans.parent_span_id IS NULL") {
        Some((name, service)) => (Some(name), service),
        // Until a root arrives, the earliest span stands for it.
        None => {
            let (name, service) = first("").expect("a span");
            (Some(name), service)
        }
    };
    (service, root, started, ended, spans, errors, running)
}

fn stored_summary(connection: &Connection) -> (String, Option<String>, i64, i64, i64, i64, i64) {
    connection
        .query_row(
            "SELECT (SELECT name FROM services WHERE id = traces.service), root_name, started_ns, ended_ns, span_count, error_count, running_count FROM traces",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .expect("trace")
}

#[test]
fn replacing_spans_keeps_the_summary_equal_to_one_read_from_all_spans() {
    let scratch = Scratch::new("replace-summary");
    let mut connection = store::open(&scratch.database()).expect("opens");
    let child = |id: &str, name: &str, start: u64, end: u64, error: bool| {
        let mut span = span(id, ROOT, name, start, end);
        if error {
            span["status"] = json!({ "code": 2 });
        }
        span
    };
    store_spans(
        &mut connection,
        &export(
            "api",
            vec![
                span(ROOT, "", "root", 1_000, 9_000),
                child("1111111111111111", "a", 2_000, 3_000, false),
                child("2222222222222222", "b", 4_000, 5_000, false),
            ],
        ),
    )
    .expect("stores");
    // Each replacement in turn: an interior span that fails, one left running, one that now ends
    // last, one that now starts first, a tie with the earliest start, a root that moves, and a
    // span moved to another service.
    let replacements: Vec<(&str, Value)> = vec![
        ("api", child("1111111111111111", "a", 2_000, 3_000, true)),
        ("api", child("2222222222222222", "b", 4_000, 0, false)),
        ("api", child("2222222222222222", "b", 4_000, 12_000, false)),
        ("worker", child("1111111111111111", "a", 500, 3_000, true)),
        (
            "worker",
            child("1111111111111111", "a", 1_000, 3_000, false),
        ),
        ("api", span(ROOT, "", "root", 3_000, 9_000)),
        (
            "worker",
            child("2222222222222222", "b", 4_000, 5_000, false),
        ),
        // The same span in the same place: the root with new attributes, left running, ending
        // last, then ending earlier while it ended last, which only a full read can settle.
        ("api", {
            let mut root = span(ROOT, "", "root", 3_000, 9_000);
            root["attributes"] = json!([{ "key": "k", "value": { "stringValue": "changed" } }]);
            root
        }),
        ("api", span(ROOT, "", "root", 3_000, 0)),
        ("api", span(ROOT, "", "root", 3_000, 20_000)),
        ("api", span(ROOT, "", "root", 3_000, 6_000)),
        (
            "worker",
            child("2222222222222222", "b", 4_000, 30_000, true),
        ),
        (
            "worker",
            child("2222222222222222", "b", 4_000, 4_500, false),
        ),
    ];
    for (index, (service, replacement)) in replacements.into_iter().enumerate() {
        store_spans(&mut connection, &export(service, vec![replacement])).expect("stores");
        assert_eq!(
            stored_summary(&connection),
            summary_from_spans(&connection),
            "after replacement {index}"
        );
    }
}

#[test]
fn a_resource_is_kept_once_and_only_while_something_refers_to_it() {
    let scratch = Scratch::new("resources");
    let mut connection = store::open(&scratch.database()).expect("opens");
    store_spans(
        &mut connection,
        &export(
            "a",
            vec![
                span(ROOT, "", "root", 1_000, 2_000),
                span(CHILD, ROOT, "child", 1_500, 1_800),
            ],
        ),
    )
    .expect("stores");
    store_spans(
        &mut connection,
        &export(
            "a",
            vec![span("2222222222222222", ROOT, "more", 1_600, 1_700)],
        ),
    )
    .expect("stores");
    assert_eq!(count(&connection, "SELECT count(*) FROM resources"), 1);
    // Moving both of resource a's spans to resource b removes a when its last span moves.
    store_spans(
        &mut connection,
        &export(
            "b",
            vec![
                span(ROOT, "", "root", 1_000, 2_000),
                span(CHILD, ROOT, "child", 1_500, 1_800),
            ],
        ),
    )
    .expect("stores");
    assert_eq!(
        count(&connection, "SELECT count(*) FROM resources"),
        2,
        "a still has a span"
    );
    store_spans(
        &mut connection,
        &export(
            "b",
            vec![span("2222222222222222", ROOT, "more", 1_600, 1_700)],
        ),
    )
    .expect("stores");
    assert_eq!(count(&connection, "SELECT count(*) FROM resources"), 1);
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM resources WHERE service_name = 'b'"
        ),
        1
    );
    // A resource a log refers to is kept even when no span refers to it.
    let logs = json!({ "resourceLogs": [{ "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "b" } }] },
        "scopeLogs": [{ "logRecords": [{ "body": { "stringValue": "x" } }] }] }] });
    store_logs(
        &mut connection,
        &decode_logs(logs.to_string().as_bytes()).expect("decodes"),
    )
    .expect("stores");
    let transaction = connection.transaction().expect("transaction");
    transaction
        .execute("DELETE FROM spans", [])
        .expect("delete");
    let resource: i64 = transaction
        .query_row("SELECT id FROM resources", [], |row| row.get(0))
        .expect("resource");
    assert!(!store::remove_resource_if_unreferenced(&transaction, resource).expect("checks"));
    transaction.execute("DELETE FROM logs", []).expect("delete");
    assert!(store::remove_resource_if_unreferenced(&transaction, resource).expect("checks"));
}

#[test]
fn an_export_that_fails_part_way_stores_nothing() {
    let scratch = Scratch::new("atomic");
    let mut connection = store::open(&scratch.database()).expect("opens");
    store_spans(
        &mut connection,
        &export("svc", vec![span(ROOT, "", "root", 1_000, 2_000)]),
    )
    .expect("stores");
    let before = snapshot(&connection);
    // A temporary trigger lives in this connection's temp schema, not the store's, and makes the
    // third span of the next export fail after two were written.
    connection
        .execute_batch("CREATE TEMP TRIGGER fail AFTER INSERT ON main.spans WHEN new.name = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END;")
        .expect("trigger");
    let failing = export(
        "other",
        vec![
            span(CHILD, ROOT, "child", 1_200, 1_300),
            span("3333333333333333", ROOT, "next", 1_300, 1_400),
            span("4444444444444444", ROOT, "boom", 1_400, 1_500),
        ],
    );
    assert!(store_spans(&mut connection, &failing).is_err());
    assert_eq!(
        snapshot(&connection),
        before,
        "a failed export left rows behind"
    );
}

#[test]
fn a_new_file_is_created_with_this_format() {
    let scratch = Scratch::new("create");
    let connection = store::open(&scratch.database()).expect("creates the store");
    assert_eq!(count(&connection, "PRAGMA user_version"), FORMAT);
    // meta, resources, services, traces, spans and logs.
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table'"
        ),
        6
    );
    drop(connection);
    store::open(&scratch.database()).expect("reopens");
}

/// A trace that grows over many exports, each also sending its root again with a new attribute,
/// as a client that reports a long operation's progress would. Keeping the summary must cost
/// about the same per export at the end as at the start, counted as the work SQLite does (its
/// virtual machine's instructions, a hundred at a time), not timed: reading the whole trace again
/// for each export would make the last exports, over 100,000 spans, many times the work of the
/// first.
#[test]
fn summary_upkeep_for_a_growing_trace_resending_its_root_stays_linear() {
    let scratch = Scratch::new("growing");
    let mut connection = store::open(&scratch.database()).expect("opens");
    let exports = 400;
    let per_export = 250;
    let steps = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let counter = steps.clone();
    connection
        .progress_handler(
            100,
            Some(move || {
                counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                false
            }),
        )
        .expect("counts");
    let mut work = Vec::with_capacity(exports);
    for number in 0..exports {
        let mut spans = Vec::with_capacity(per_export + 1);
        let mut root = span(ROOT, "", "root", 1_000, 0);
        root["attributes"] =
            json!([{ "key": "progress", "value": { "intValue": number.to_string() } }]);
        spans.push(root);
        for index in 0..per_export {
            let id = format!("{:016x}", number * per_export + index + 1);
            // Later exports' spans start later, as a running operation's do.
            let start = 2_000 + (number * per_export + index) as u64;
            spans.push(span(&id, ROOT, "step", start, start + 1_000));
        }
        let exported = export("svc", spans);
        let before = steps.load(std::sync::atomic::Ordering::Relaxed);
        store_spans(&mut connection, &exported).expect("stores");
        work.push(steps.load(std::sync::atomic::Ordering::Relaxed) - before);
    }
    connection
        .progress_handler(0, None::<fn() -> bool>)
        .expect("stops counting");
    for at in (0..exports).step_by(50) {
        let chunk: u64 = work[at..at + 10].iter().sum();
        eprintln!(
            "exports {at}..{}: {} hundred instructions each",
            at + 10,
            chunk / 10
        );
    }
    assert_eq!(stored_summary(&connection), summary_from_spans(&connection));
    // The indexes deepen as the trace grows, by a level or two; reading the trace again would
    // multiply the work by the trace's size.
    let window = 40;
    let early: u64 = work[window..2 * window].iter().sum();
    let late: u64 = work[exports - window..].iter().sum();
    assert!(
        late < early * 3 / 2,
        "the last {window} exports took {late} hundred instructions, the {window} after the first {window} took {early}"
    );
}

// --- Text matching ---------------------------------------------------------------------------

/// Every code point (but NUL), as SQLite's FTS5 `unicode61` tokenizes `x<c>y`: `None` when it
/// separates `x` from `y`, else the token's middle, folded (empty when it is dropped).
fn fts5_code_points() -> Vec<(char, Option<String>)> {
    let connection = Connection::open_in_memory().expect("memory");
    connection
        .execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61');
             CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');",
        )
        .expect("fts5");
    let characters: Vec<char> = (1..=0x10FFFF).filter_map(char::from_u32).collect();
    let transaction = connection.unchecked_transaction().expect("begin");
    for chunk in characters.chunks(1000) {
        let document: String = chunk.iter().map(|c| format!("x{c}y ")).collect();
        transaction
            .execute("INSERT INTO t (x) VALUES (?1)", [document])
            .expect("insert");
    }
    transaction.commit().expect("commit");
    let mut statement = connection
        .prepare("SELECT term FROM v ORDER BY doc, offset")
        .expect("prepare");
    let mut terms = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("terms")
        .map(|term| term.expect("term"));
    characters
        .into_iter()
        .map(|character| {
            let term = terms.next().expect("a term for every code point");
            if term == "x" {
                assert_eq!(terms.next().as_deref(), Some("y"), "{character:?}");
                (character, None)
            } else {
                let middle = term
                    .strip_prefix('x')
                    .and_then(|rest| rest.strip_suffix('y'))
                    .unwrap_or_else(|| panic!("{character:?} gave {term:?}"));
                (character, Some(middle.to_owned()))
            }
        })
        .collect()
}

#[test]
fn text_tokens_agree_with_fts5_unicode61_for_every_code_point() {
    let mut differences = Vec::new();
    for (character, expected) in fts5_code_points() {
        let expected = match expected {
            None => vec!["x".to_owned(), "y".to_owned()],
            Some(middle) => vec![format!("x{middle}y")],
        };
        let actual = executor_collector::text::tokens(&format!("x{character}y"));
        if actual != expected {
            differences.push(format!(
                "U+{:04X}: {actual:?} != {expected:?}",
                u32::from(character)
            ));
        }
    }
    assert!(
        differences.is_empty(),
        "{} code points differ, first: {:?}",
        differences.len(),
        &differences[..differences.len().min(20)]
    );
}

/// Motel's `toFtsMatchQuery`: the query's words, each a prefix term, joined with AND; `None`
/// when it has no word, and Motel used `LIKE`.
fn motel_fts_query(query: &str) -> Option<String> {
    let words: Vec<String> = query
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|word| word.len() > 1)
        .map(|word| format!("{word}*"))
        .collect();
    (!words.is_empty()).then(|| words.join(" AND "))
}

/// A small generator of test strings, the same every run.
struct Strings(u64);

impl Strings {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn string(&mut self, alphabet: &[&str], longest: u64) -> String {
        let length = self.next() % longest + 1;
        (0..length)
            .map(|_| alphabet[(self.next() % alphabet.len() as u64) as usize])
            .collect()
    }
}

#[test]
fn operation_and_body_matching_agrees_with_motels_fts5_and_like() {
    let alphabet = [
        "a", "b", "A", "B", "ab", "ba", "1", "_", "__", " ", "-", ".", "/", "%", "é", "É", "İ",
        "\u{301}", "ß", "中", "ǅ", "ı", "ﬁ", "\t", "\u{0}", "😀",
    ];
    let mut strings = Strings(0x9E37_79B9_7F4A_7C15);
    let mut texts: Vec<String> = [
        "İstanbul action",
        "one\u{301}two",
        "one two",
        "http.server.request",
        "GET /api/users/{id}",
        "sql_execute select",
        "schedule.dispatch",
        "Résumé parsed",
        "a_b_c_d",
        "",
        "100% done",
        "under_score",
        "ÆØÅ æøå",
        "中文 日本語",
        "x\u{0}😀",
        "x😀y",
        "😀.end",
        "x\u{0}s",
        "ends with s",
    ]
    .iter()
    .map(|text| (*text).to_owned())
    .collect();
    for _ in 0..400 {
        texts.push(strings.string(&alphabet, 12));
    }
    let mut queries: Vec<String> = [
        "__",
        "___",
        "istanbul",
        "two",
        "one",
        "http",
        "server_req",
        "SERVER",
        "api users",
        "sql_",
        "_sql",
        "a_b",
        "b_c_d",
        "c_d_e",
        "%",
        "_",
        "e",
        "é",
        "%done",
        "100%",
        "s",
        "ß",
        "résumé",
        "resume",
        "ab ab",
        "ab_ab",
        "x_",
        "one__two",
        "dispatch sched",
        "中",
        "😀",
        "\u{0}",
        "s\u{0}",
        "a\u{0}b",
        "%\u{0}",
        "_\u{0}",
        "s\u{0}x",
        "\u{0}%",
    ]
    .iter()
    .map(|query| (*query).to_owned())
    .collect();
    for _ in 0..400 {
        queries.push(strings.string(&alphabet, 6));
    }

    let connection = Connection::open_in_memory().expect("memory");
    connection
        .execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61');
             CREATE TABLE plain (id INTEGER PRIMARY KEY, x TEXT NOT NULL);",
        )
        .expect("tables");
    for (id, text) in texts.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO t (rowid, x) VALUES (?1, ?2)",
                rusqlite::params![id as i64, text],
            )
            .expect("fts row");
        connection
            .execute(
                "INSERT INTO plain (id, x) VALUES (?1, ?2)",
                rusqlite::params![id as i64, text],
            )
            .expect("row");
    }
    let mut checked = 0;
    let mut differences = Vec::new();
    for query in &queries {
        let expected: Vec<i64> = match motel_fts_query(query) {
            Some(fts) => {
                let found: rusqlite::Result<Vec<i64>> = connection
                    .prepare("SELECT rowid FROM t WHERE t MATCH ?1 ORDER BY rowid")
                    .and_then(|mut statement| {
                        statement.query_map([fts], |row| row.get(0))?.collect()
                    });
                // FTS5 refuses a bare AND, OR or NOT, and Motel failed the request; the alphabet
                // here cannot make one.
                found.unwrap_or_else(|error| panic!("{query:?}: {error}"))
            }
            None => connection
                .prepare("SELECT id FROM plain WHERE x LIKE ?1 COLLATE NOCASE ORDER BY id")
                .and_then(|mut statement| {
                    statement
                        .query_map([format!("%{query}%")], |row| row.get(0))?
                        .collect()
                })
                .expect("like"),
        };
        let matcher = executor_collector::text::TextMatch::new(query);
        let mut scratch = Connection::open_in_memory().expect("memory");
        let (_, body) = executor_collector::readers::collect(&mut scratch, |_, out| {
            let mut found = Vec::new();
            for (id, text) in texts.iter().enumerate() {
                if matcher.matches(text, out)? {
                    found.push(id as i64);
                }
            }
            out.start(axum::http::StatusCode::OK)?;
            out.json(&found)
        })
        .expect("matching");
        let actual: Vec<i64> = serde_json::from_slice(&body).expect("ids");
        if actual != expected {
            differences.push(format!("{query:?}: {actual:?} != {expected:?}"));
        }
        checked += 1;
    }
    assert!(checked > 400);
    assert!(
        differences.is_empty(),
        "{} of {checked} queries differ, first: {:?}",
        differences.len(),
        &differences[..differences.len().min(10)]
    );
}

/// An export that touches more traces than the writer holds summaries for (`SUMMARY_BATCH`)
/// writes them in batches; a trace touched again after its summary was written is read again,
/// so every summary is what its spans say: here trace 0 gets its root, and trace 1 an earlier
/// span, after 5,000 other traces.
#[test]
fn summaries_written_in_batches_are_what_their_spans_say() {
    use executor_collector::store::SUMMARY_BATCH;
    let scratch = Scratch::new("batches");
    let mut connection = store::open(&scratch.database()).expect("opens");
    let traces = SUMMARY_BATCH + 1_000;
    let trace = |number: usize| format!("{:032x}", 0xba7c_0000_usize + number);
    let at = |ms: u64| (EPOCH_NS + ms * 1_000_000).to_string();
    let mut spans: Vec<Value> = (0..traces)
        .map(|number| {
            json!({ "traceId": trace(number), "spanId": format!("{:016x}", number + 1), "parentSpanId": "00000000000000ff",
                    "name": format!("child {number}"), "startTimeUnixNano": at(100), "endTimeUnixNano": at(200) })
        })
        .collect();
    spans.push(
        json!({ "traceId": trace(0), "spanId": "000000000000f001", "name": "late root",
                       "startTimeUnixNano": at(50), "endTimeUnixNano": at(300) }),
    );
    spans.push(json!({ "traceId": trace(1), "spanId": "000000000000f002", "parentSpanId": "00000000000000ff",
                       "name": "earlier", "startTimeUnixNano": at(10), "endTimeUnixNano": at(20) }));
    store_spans(&mut connection, &export("svc", spans)).expect("stores");
    let wrong = count(
        &connection,
        "SELECT count(*) FROM traces AS t WHERE
           span_count != (SELECT count(*) FROM spans WHERE trace = t.id)
           OR started_ns != (SELECT min(start_ns) FROM spans WHERE trace = t.id)
           OR ended_ns != (SELECT max(end_ns) FROM spans WHERE trace = t.id)
           OR root_name IS NOT (SELECT name FROM spans WHERE trace = t.id ORDER BY parent_span_id IS NOT NULL, start_ns, id LIMIT 1)
           OR (SELECT name FROM services WHERE id = t.service) != 'svc'",
    );
    assert_eq!(wrong, 0, "summaries that disagree with their spans");
    assert_eq!(
        count(&connection, "SELECT count(*) FROM traces"),
        traces as i64
    );
    let root: String = connection
        .query_row(
            &format!(
                "SELECT root_name FROM traces WHERE hex(trace_id) = upper('{}')",
                trace(0)
            ),
            [],
            |row| row.get(0),
        )
        .expect("trace 0");
    assert_eq!(root, "late root");
}

/// A trace refers to its service (`services`): the name is written once however many traces have
/// it, a service no trace refers to any more is removed, after a trace takes another service and
/// after eviction.
#[test]
fn services_are_written_once_and_forgotten_with_their_last_trace() {
    use executor_collector::retention::{self, Limits};
    let scratch = Scratch::new("services");
    let mut connection = store::open(&scratch.database()).expect("opens");
    let trace = |number: usize| format!("{:032x}", 0x5e7_0000_usize + number);
    let at = |ms: u64| (EPOCH_NS + ms * 1_000_000).to_string();
    let root = |trace: String, span: &str, start: u64| json!({ "traceId": trace, "spanId": span, "name": "root", "startTimeUnixNano": at(start), "endTimeUnixNano": at(start + 10) });
    let services = |connection: &Connection| -> Vec<String> {
        connection
            .prepare("SELECT name FROM services ORDER BY name")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("rows")
            .map(|name| name.expect("name"))
            .collect()
    };
    let many: Vec<Value> = (0..100)
        .map(|number| root(trace(number), &format!("{:016x}", number + 1), 100))
        .collect();
    store_spans(&mut connection, &export("a", many)).expect("stores");
    store_spans(
        &mut connection,
        &export("b", vec![root(trace(100), "00000000000000aa", 100)]),
    )
    .expect("stores");
    assert_eq!(services(&connection), ["a", "b"], "one row a service");
    // Trace 100 gets an earlier root in service a: it takes a, and b has no trace left.
    store_spans(
        &mut connection,
        &export("a", vec![root(trace(100), "00000000000000ab", 50)]),
    )
    .expect("stores");
    assert_eq!(
        services(&connection),
        ["a"],
        "a service with no trace was kept"
    );
    // Every trace evicted: no service is left.
    let limits = Limits {
        max_bytes: 4096,
        retention_ms: 0,
    };
    for _ in 0..1_000 {
        if !retention::work(&connection, &limits, i64::MAX / 2)
            .expect("work")
            .0
        {
            break;
        }
        retention::step(&mut connection, &limits, i64::MAX / 2, retention::STEP_ROWS)
            .expect("step");
    }
    assert_eq!(count(&connection, "SELECT count(*) FROM traces"), 0);
    assert_eq!(
        services(&connection),
        Vec::<String>::new(),
        "a service outlived its traces"
    );
}

/// An export that grows the database or the write-ahead log past its `WriteLimit` while it is
/// stored is refused and rolled back: every row of every table, services and resources included,
/// is as it was, and the store takes exports again. Spans and logs, each limit on its own.
#[test]
fn an_export_past_its_write_limit_is_rolled_back_and_leaves_the_store_as_it_was() {
    use store::{StoreError, WriteLimit};
    let scratch = Scratch::new("write-limit");
    let mut connection = store::open(&scratch.database()).expect("opens");
    store_spans(
        &mut connection,
        &export("kept", vec![span(ROOT, "", "kept-root", 1, 2)]),
    )
    .expect("stores");
    let kept_logs = decode_logs(
        json!({ "resourceLogs": [{ "resource": { "attributes": [] }, "scopeLogs": [{ "logRecords": [
            { "timeUnixNano": EPOCH_NS.to_string(), "body": { "stringValue": "kept" } }
        ] }] }] })
        .to_string()
        .as_bytes(),
    )
    .expect("decodes");
    store_logs(&mut connection, &kept_logs).expect("stores");
    let everything = |connection: &Connection| {
        let mut rows = snapshot(connection);
        for sql in [
            "SELECT id, name FROM services ORDER BY id",
            "SELECT id, hex(trace_id), resource, scope_name, severity_text, time_ns, body, attributes_json FROM logs ORDER BY id",
        ] {
            let mut statement = connection.prepare(sql).expect("prepare");
            let columns = statement.column_count();
            let mut query = statement.query([]).expect("query");
            while let Some(row) = query.next().expect("row") {
                rows.push(
                    (0..columns)
                        .map(|index| format!("{:?}", row.get_ref(index).expect("value")))
                        .collect::<Vec<_>>()
                        .join("|"),
                );
            }
        }
        rows
    };
    let before = everything(&connection);
    // Many new traces, each in its own service and resource, and many long logs.
    let spans: Vec<Value> = (0..2_000)
        .map(|index| {
            let mut span = span(&format!("{:016x}", index + 1), "", "new", 1, 2);
            span["traceId"] = json!(format!("{:032x}", index + 1));
            span
        })
        .collect();
    let body = json!({ "resourceSpans": (0..20).map(|resource| json!({
        "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": format!("new-{resource}") } }] },
        "scopeSpans": [{ "scope": { "name": "s" }, "spans": spans[resource * 100..(resource + 1) * 100] }],
    })).collect::<Vec<_>>() });
    let new_spans = decode_spans(body.to_string().as_bytes()).expect("decodes");
    let new_logs = decode_logs(
        json!({ "resourceLogs": [{ "resource": { "attributes": [] }, "scopeLogs": [{ "logRecords":
            (0..500).map(|_| json!({ "timeUnixNano": EPOCH_NS.to_string(), "body": { "stringValue": "x".repeat(2_000) } })).collect::<Vec<_>>()
        }] }] })
        .to_string()
        .as_bytes(),
    )
    .expect("decodes");
    let small = 64 << 10;
    for (case, limit) in [
        (
            "the database",
            WriteLimit {
                database_bytes: small,
                log_bytes: u64::MAX,
            },
        ),
        (
            "the log",
            WriteLimit {
                database_bytes: u64::MAX,
                log_bytes: small,
            },
        ),
    ] {
        let spans = store::store_spans_within(&mut connection, &new_spans, 5, limit);
        assert!(
            matches!(spans, Err(StoreError::TooMuchDisk { .. })),
            "{case}: spans {spans:?}"
        );
        assert_eq!(everything(&connection), before, "{case}: spans left rows");
        let logs = store::store_logs_within(&mut connection, &new_logs, 5, limit);
        assert!(
            matches!(logs, Err(StoreError::TooMuchDisk { .. })),
            "{case}: logs {logs:?}"
        );
        assert_eq!(everything(&connection), before, "{case}: logs left rows");
    }
    // Within a limit large enough, the same exports are stored.
    let roomy = WriteLimit::for_export_limit(16 << 20);
    assert_eq!(
        store::store_spans_within(&mut connection, &new_spans, 5, roomy).expect("stores"),
        2_000
    );
    assert_eq!(
        store::store_logs_within(&mut connection, &new_logs, 5, roomy).expect("stores"),
        500
    );
    assert_eq!(count(&connection, "SELECT count(*) FROM services"), 21);
}

/// Each export's log is measured from zero: the writer restarts SQLite's count of pages written
/// when an export's measurement begins, so no export comes near the count's 31-bit wrap (where
/// a start value near 2^31 would make every later reading look like no growth). A large export
/// stored without a limit writes many pages; a small one stored after it under a limit is
/// measured, and leaves the count at its own pages, not the sum. A failed status call is an
/// error, not a zero.
#[test]
fn each_exports_log_is_measured_from_zero_and_a_failed_count_is_an_error() {
    use store::{WriteLimit, pages_written};
    let scratch = Scratch::new("write-count");
    let mut connection = store::open(&scratch.database()).expect("opens");
    let spans = |first: usize, count: usize| {
        let spans: Vec<Value> = (first..first + count)
            .map(|index| {
                let mut span = span(&format!("{:016x}", index + 1), "", &"n".repeat(500), 1, 2);
                span["traceId"] = json!(format!("{:032x}", index + 1));
                span
            })
            .collect();
        export("count", spans)
    };
    store_spans(&mut connection, &spans(0, 5_000)).expect("stores");
    let large = pages_written(&connection, false).expect("counts");
    assert!(large > 500, "the large export wrote {large} pages");
    let roomy = WriteLimit::for_export_limit(16 << 20);
    store::store_spans_within(&mut connection, &spans(10_000, 20), 5, roomy).expect("stores");
    let small = pages_written(&connection, false).expect("counts");
    assert!(
        small > 0 && small < 100,
        "the small export's count is {small}, after {large} before it"
    );
    // A second small export is measured from zero again.
    store::store_spans_within(&mut connection, &spans(20_000, 20), 5, roomy).expect("stores");
    let again = pages_written(&connection, false).expect("counts");
    assert!(again > 0 && again < 100, "{again}");
    assert!(store::db_status(&connection, 9_999, false).is_err());
}
