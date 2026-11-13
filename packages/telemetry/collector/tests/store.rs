//! The store: resent and changed spans, trace summaries, resource references, that an export is
//! all or nothing, and which files it refuses. `process.rs` interrupts a real first start.

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
        let path = std::env::temp_dir().join(format!(
            "executor-collector-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("scratch directory");
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

fn span(id: &str, parent: &str, name: &str, start: u64, end: u64) -> Value {
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
        "SELECT id, hex(trace_id), service_name, root_name, root_started_ns, started_ns, ended_ns, last_seen_ms, span_count, error_count, running_count FROM traces ORDER BY id",
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
            .query_row("SELECT service_name, root_name FROM traces", [], |row| Ok(
                (row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)
            ))
            .expect("trace"),
        ("worker".to_owned(), None)
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
        .query_row("SELECT service_name, root_name, started_ns, ended_ns, span_count, error_count, running_count FROM traces", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
        })
        .expect("trace");
    assert_eq!(
        kept,
        (
            "api".to_owned(),
            Some("root".to_owned()),
            1_000,
            9_000,
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
        .query_row("SELECT service_name, root_name, started_ns, ended_ns, span_count, error_count, running_count FROM traces", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
        })
        .expect("trace");
    assert_eq!(recomputed, kept);
}

/// The trace's summary as `recompute_summary` would give it, written out independently.
fn summary_from_spans(
    connection: &Connection,
) -> (String, Option<String>, i64, i64, i64, i64, i64) {
    let (spans, errors, running, started, ended): (i64, i64, i64, i64, i64) = connection
        .query_row(
            "SELECT count(*), sum(status), sum(end_ns <= 0 OR end_ns < start_ns), min(start_ns), max(end_ns) FROM spans",
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
        None => (None, first("").expect("a span").1),
    };
    (service, root, started, ended, spans, errors, running)
}

fn stored_summary(connection: &Connection) -> (String, Option<String>, i64, i64, i64, i64, i64) {
    connection
        .query_row(
            "SELECT service_name, root_name, started_ns, ended_ns, span_count, error_count, running_count FROM traces",
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
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table'"
        ),
        5
    );
    drop(connection);
    store::open(&scratch.database()).expect("reopens");
}

#[test]
fn a_store_of_another_format_or_shape_is_refused_and_left_alone() {
    for (name, setup, message) in [
        (
            "newer",
            format!("PRAGMA user_version = {};", FORMAT + 1),
            "newer",
        ),
        (
            "foreign",
            "CREATE TABLE other (x);".to_owned(),
            "not a telemetry store",
        ),
        (
            "altered",
            "DROP INDEX spans_start;".to_owned(),
            "do not match",
        ),
    ] {
        let scratch = Scratch::new(name);
        drop(store::open(&scratch.database()).expect("creates"));
        if name == "foreign" {
            std::fs::remove_file(scratch.database()).expect("remove");
            let _ = std::fs::remove_file(scratch.database().with_extension("sqlite-wal"));
            let _ = std::fs::remove_file(scratch.database().with_extension("sqlite-shm"));
        }
        let raw = Connection::open(scratch.database()).expect("raw");
        raw.execute_batch(&setup).expect("setup");
        let tables = count(&raw, "SELECT count(*) FROM sqlite_schema");
        let version = count(&raw, "PRAGMA user_version");
        drop(raw);
        let error = store::open(&scratch.database()).expect_err("refused");
        assert!(error.contains(message), "{name}: {error}");
        let raw = Connection::open(scratch.database()).expect("raw");
        assert_eq!(
            (
                count(&raw, "SELECT count(*) FROM sqlite_schema"),
                count(&raw, "PRAGMA user_version")
            ),
            (tables, version),
            "{name}: the file changed"
        );
    }
}
