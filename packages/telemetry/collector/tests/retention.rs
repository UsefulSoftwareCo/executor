//! Retention through the library: age and size eviction and their order, the bound on one step
//! with a very large trace, a span that arrives for a trace being evicted, resource references
//! through deletion, returning free pages, and the store format policy. `process.rs` kills the
//! binary during a drain and holds the write-ahead log's bound under load.

use std::path::{Path, PathBuf};
use std::time::Instant;

use executor_collector::otlp::{Logs, Spans, decode_logs, decode_spans};
use executor_collector::retention::{self, Limits, STEP_ROWS, Size};
use executor_collector::store::{self, APPLICATION_ID, FORMAT, store_logs, store_spans};
use rusqlite::Connection;

/// A directory removed when the test ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "executor-collector-retention-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("scratch directory");
        Scratch(path)
    }

    fn database(&self) -> PathBuf {
        store::database_path(&self.0)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const HOUR_MS: i64 = 3_600_000;
/// How many times the cost of storing as many rows a retention step may take, at the median.
const STEP_COST_LIMIT: u32 = 2;
/// A fixed "now" for age tests, well after every time the tests write.
const NOW_MS: i64 = 4_000_000_000_000;

/// A trace id from a number.
fn trace_id(number: u64) -> String {
    format!("{number:032x}")
}

/// A span id from a number; never zero.
fn span_id(number: u64) -> String {
    format!("{:016x}", number + 1)
}

/// One export holding `spans` spans of one trace, under a resource with `service`. Each span has
/// an attribute of `padding` bytes.
fn spans_export(trace: u64, first_span: u64, spans: u64, service: &str, padding: usize) -> Spans {
    let pad = "x".repeat(padding);
    let rows: Vec<String> = (first_span..first_span + spans)
        .map(|span| {
            let parent = if span == 0 { String::new() } else { span_id(0) };
            format!(
                r#"{{"traceId":"{}","spanId":"{}","parentSpanId":"{parent}","name":"op","startTimeUnixNano":"{}","endTimeUnixNano":"{}","attributes":[{{"key":"pad","value":{{"stringValue":"{pad}"}}}}]}}"#,
                trace_id(trace),
                span_id(span),
                1_000 + span,
                2_000 + span
            )
        })
        .collect();
    let body = format!(
        r#"{{"resourceSpans":[{{"resource":{{"attributes":[{{"key":"service.name","value":{{"stringValue":"{service}"}}}}]}},"scopeSpans":[{{"spans":[{}]}}]}}]}}"#,
        rows.join(",")
    );
    decode_spans(body.as_bytes()).expect("decodes")
}

/// One export of `count` logs, with `trace` as their trace id when given.
fn logs_export(count: usize, trace: Option<u64>, service: &str, padding: usize) -> Logs {
    let pad = "y".repeat(padding);
    let trace = trace.map_or(String::new(), |trace| {
        format!(r#","traceId":"{}""#, trace_id(trace))
    });
    let rows: Vec<String> = (0..count)
        .map(|index| {
            format!(
                r#"{{"timeUnixNano":"{index}","severityText":"INFO","body":{{"stringValue":"line {index} {pad}"}}{trace}}}"#
            )
        })
        .collect();
    let body = format!(
        r#"{{"resourceLogs":[{{"resource":{{"attributes":[{{"key":"service.name","value":{{"stringValue":"{service}"}}}}]}},"scopeLogs":[{{"logRecords":[{}]}}]}}]}}"#,
        rows.join(",")
    );
    decode_logs(body.as_bytes()).expect("decodes")
}

fn count(connection: &Connection, sql: &str) -> i64 {
    connection
        .query_row(sql, [], |row| row.get(0))
        .expect("query")
}

/// Set the times the store wrote for one trace, as if it had arrived at `first` and last been
/// written at `last`.
fn age_trace(connection: &Connection, trace: u64, first: i64, last: i64) {
    let changed = connection
        .execute(
            "UPDATE traces SET first_seen_ms = ?1, last_seen_ms = ?2 WHERE hex(trace_id) = upper(?3)",
            rusqlite::params![first, last, trace_id(trace)],
        )
        .expect("update");
    assert_eq!(changed, 1, "trace {trace} is stored");
}

/// Set the time the store wrote every log not yet aged: those still holding the real time, which
/// is long before every time the tests set.
fn age_new_logs(connection: &Connection, seen: i64) {
    connection
        .execute(
            "UPDATE logs SET seen_ms = ?1 WHERE seen_ms < ?2",
            rusqlite::params![seen, NOW_MS - 1_000 * HOUR_MS],
        )
        .expect("update");
}

/// Whether a trace's row is stored.
fn stored(connection: &Connection, trace: u64) -> bool {
    count(
        connection,
        &format!(
            "SELECT count(*) FROM traces WHERE hex(trace_id) = upper('{}')",
            trace_id(trace)
        ),
    ) == 1
}

/// Every reference in the store points at a row that exists, every resource is referred to, and
/// every trace's span count is its spans'.
fn assert_consistent(connection: &Connection) {
    for (what, sql) in [
        (
            "spans without their trace",
            "SELECT count(*) FROM spans WHERE trace NOT IN (SELECT id FROM traces)",
        ),
        (
            "spans without their resource",
            "SELECT count(*) FROM spans WHERE resource NOT IN (SELECT id FROM resources)",
        ),
        (
            "logs without their resource",
            "SELECT count(*) FROM logs WHERE resource NOT IN (SELECT id FROM resources)",
        ),
        (
            "resources nothing refers to",
            "SELECT count(*) FROM resources WHERE id NOT IN (SELECT resource FROM spans) AND id NOT IN (SELECT resource FROM logs)",
        ),
        (
            "traces whose span count is wrong",
            "SELECT count(*) FROM traces WHERE span_count != (SELECT count(*) FROM spans WHERE trace = traces.id)
               AND id IS NOT (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'evicting')",
        ),
    ] {
        assert_eq!(count(connection, sql), 0, "{what}");
    }
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("integrity_check");
    assert_eq!(integrity, "ok");
}

/// Run steps until retention has no eviction left, at most `limit` steps. Returns the steps.
fn drain(
    connection: &mut Connection,
    limits: &Limits,
    now: i64,
    limit: usize,
) -> Vec<retention::Step> {
    let mut steps = Vec::new();
    loop {
        let (evict, _) = retention::work(connection, limits, now).expect("work");
        if !evict {
            return steps;
        }
        assert!(
            steps.len() < limit,
            "retention still had work after {limit} steps"
        );
        steps.push(retention::step(connection, limits, now, STEP_ROWS).expect("step"));
    }
}

const WEEK: Limits = Limits {
    max_bytes: 1 << 40,
    retention_ms: 168 * HOUR_MS,
};

#[test]
fn age_evicts_traces_and_logs_last_written_before_the_retention_period() {
    let scratch = Scratch::new("age");
    let mut connection = store::open(&scratch.database()).expect("opens");
    for trace in 1..=4 {
        store_spans(&mut connection, &spans_export(trace, 0, 3, "svc", 10)).expect("stores");
    }
    // Arrived in order 1..4. Trace 2 arrived long ago but was written to an hour ago.
    let week = 168 * HOUR_MS;
    age_trace(
        &connection,
        1,
        NOW_MS - week - 3 * HOUR_MS,
        NOW_MS - week - 2 * HOUR_MS,
    );
    age_trace(
        &connection,
        2,
        NOW_MS - week - 3 * HOUR_MS,
        NOW_MS - HOUR_MS,
    );
    age_trace(&connection, 3, NOW_MS - week - HOUR_MS, NOW_MS - week - 1);
    age_trace(&connection, 4, NOW_MS - HOUR_MS, NOW_MS - HOUR_MS);
    store_logs(&mut connection, &logs_export(5, None, "svc", 10)).expect("stores");
    age_new_logs(&connection, NOW_MS - week - 1);
    store_logs(&mut connection, &logs_export(3, None, "svc", 10)).expect("stores");
    age_new_logs(&connection, NOW_MS - week + HOUR_MS);

    drain(&mut connection, &WEEK, NOW_MS, 10);

    assert!(!stored(&connection, 1), "trace 1 expired");
    assert!(
        stored(&connection, 2),
        "trace 2 was written within the period"
    );
    assert!(!stored(&connection, 3), "trace 3 expired");
    assert!(stored(&connection, 4));
    assert_eq!(
        count(&connection, "SELECT count(*) FROM logs"),
        3,
        "the 5 expired logs went, the 3 recent stayed"
    );
    assert_eq!(count(&connection, "SELECT count(*) FROM spans"), 6);
    assert_consistent(&connection);
    // Exactly at the cutoff is kept.
    age_trace(&connection, 4, NOW_MS - week, NOW_MS - week);
    drain(&mut connection, &WEEK, NOW_MS, 10);
    assert!(
        stored(&connection, 4),
        "a trace last written exactly at the cutoff is kept"
    );
}

/// Fill a store with `traces` traces of 10 spans, alternating with log exports, each arriving one
/// second after the last. Returns the store's limits with a bound of `percent` of what it holds.
fn filled(connection: &mut Connection, traces: u64, percent: u64) -> Limits {
    for trace in 1..=traces {
        store_spans(connection, &spans_export(trace, 0, 10, "svc", 500)).expect("stores");
        let arrived = NOW_MS - HOUR_MS + trace as i64 * 2_000;
        age_trace(connection, trace, arrived, arrived);
        store_logs(connection, &logs_export(10, None, "svc", 500)).expect("stores");
        age_new_logs(connection, arrived + 1_000);
    }
    let used = Size::read(connection).expect("size").used_bytes();
    Limits {
        max_bytes: used / 100 * percent,
        retention_ms: 168 * HOUR_MS,
    }
}

#[test]
fn size_evicts_what_arrived_first_traces_and_logs_alike_down_to_the_low_water_mark() {
    let scratch = Scratch::new("size");
    let mut connection = store::open(&scratch.database()).expect("opens");
    let limits = filled(&mut connection, 60, 50);
    assert!(
        retention::work(&connection, &limits, NOW_MS)
            .expect("work")
            .0
    );

    let steps = drain(&mut connection, &limits, NOW_MS, 1_000);

    let size = Size::read(&connection).expect("size");
    assert!(
        size.used_bytes() <= limits.low_water_bytes(),
        "the drain ended at {} bytes, above the low-water mark {}",
        size.used_bytes(),
        limits.low_water_bytes()
    );
    assert!(!retention::draining(&connection).expect("draining"));
    // What remains is a suffix of what arrived: no older trace or log outlived a newer one.
    let oldest_trace: i64 = count(&connection, "SELECT min(first_seen_ms) FROM traces");
    let newest_gone_trace = (1..=60u64)
        .filter(|trace| !stored(&connection, *trace))
        .max()
        .expect("some trace was evicted");
    assert!(
        (1..=newest_gone_trace).all(|trace| !stored(&connection, trace)),
        "traces were evicted out of order"
    );
    let oldest_log: i64 = count(&connection, "SELECT min(seen_ms) FROM logs");
    // Logs and traces were evicted together by arrival: the oldest of each is within one export.
    assert!(
        (oldest_log - oldest_trace).abs() <= 2_000,
        "the oldest log arrived at {oldest_log} and the oldest trace at {oldest_trace}"
    );
    assert!(steps.iter().all(|step| step.rows() <= STEP_ROWS as u64));
    assert_consistent(&connection);
}

#[test]
fn a_drain_continues_after_a_restart_and_does_not_start_again_below_the_bound() {
    let scratch = Scratch::new("drain-restart");
    let limits = {
        let mut connection = store::open(&scratch.database()).expect("opens");
        let limits = filled(&mut connection, 60, 50);
        // One step, then the process ends.
        let step = retention::step(&mut connection, &limits, NOW_MS, 50).expect("step");
        assert!(step.rows() > 0);
        assert!(retention::draining(&connection).expect("draining"));
        limits
    };
    let mut connection = store::open(&scratch.database()).expect("reopens");
    assert!(
        retention::draining(&connection).expect("draining"),
        "the drain was forgotten"
    );
    drain(&mut connection, &limits, NOW_MS, 1_000);
    let low = Size::read(&connection).expect("size").used_bytes();
    assert!(low <= limits.low_water_bytes());
    // A small export below the bound starts no new drain.
    store_spans(&mut connection, &spans_export(1_000, 0, 2, "svc", 10)).expect("stores");
    age_trace(&connection, 1_000, NOW_MS, NOW_MS);
    assert!(
        !retention::work(&connection, &limits, NOW_MS)
            .expect("work")
            .0
    );
}

#[test]
fn a_very_large_trace_is_evicted_in_bounded_steps_without_blocking_the_drain() {
    let scratch = Scratch::new("large");
    let mut connection = store::open(&scratch.database()).expect("opens");
    // The oldest trace: 100,000 spans and 10,000 logs, from 20 exports.
    let big = 7;
    // Storing the trace calibrates the machine: a step's time is compared with the time this run
    // took to store as many rows.
    let storing = Instant::now();
    for part in 0..20 {
        store_spans(
            &mut connection,
            &spans_export(big, part * 5_000, 5_000, "big", 100),
        )
        .expect("stores");
        store_logs(&mut connection, &logs_export(500, Some(big), "big", 100)).expect("stores");
    }
    let per_step_of_storing = storing.elapsed() / 110;
    age_trace(&connection, big, NOW_MS - 2 * HOUR_MS, NOW_MS - 2 * HOUR_MS);
    for trace in 100..110 {
        store_spans(&mut connection, &spans_export(trace, 0, 10, "small", 100)).expect("stores");
        age_trace(&connection, trace, NOW_MS - HOUR_MS, NOW_MS - HOUR_MS);
    }
    let used = Size::read(&connection).expect("size").used_bytes();
    // A bound the small traces fit in but the big one does not.
    let limits = Limits {
        max_bytes: used / 2,
        retention_ms: 168 * HOUR_MS,
    };

    let mut steps = 0;
    let mut times = Vec::new();
    let mut marked_steps = 0;
    let mut between = Vec::new();
    let mut deleting_steps = 0;
    let mut deleted = 0;
    while retention::work(&connection, &limits, NOW_MS)
        .expect("work")
        .0
    {
        let started = Instant::now();
        let step = retention::step(&mut connection, &limits, NOW_MS, STEP_ROWS).expect("step");
        times.push(started.elapsed());
        steps += 1;
        if step.rows() > 0 {
            deleting_steps += 1;
            deleted += step.rows();
        }
        assert!(
            step.rows() <= STEP_ROWS as u64,
            "a step deleted {} rows",
            step.rows()
        );
        if retention::evicting(&connection)
            .expect("evicting")
            .is_some()
        {
            marked_steps += 1;
            // While part deleted, the trace is marked, so queries leave it out.
            assert!(stored(&connection, big));
            // The writer stores exports between steps: a new trace is stored while the big one
            // is still being deleted.
            let trace = 1_000 + marked_steps;
            store_spans(&mut connection, &spans_export(trace, 0, 1, "between", 10))
                .expect("stores");
            age_trace(&connection, trace, NOW_MS, NOW_MS);
            assert!(stored(&connection, trace), "trace {trace} between steps");
            between.push(trace);
        }
        assert!(steps <= 200, "the drain did not end");
    }
    assert!(!stored(&connection, big), "the oldest trace was evicted");
    // 100,000 spans and 10,000 logs, at most `STEP_ROWS` rows a step and every step that deletes
    // full: the spans in steps that mark the trace, its logs (older by arrival than its last
    // spans) in steps of their own. Steps that only return free pages delete nothing.
    assert_eq!(
        (deleted, deleting_steps, marked_steps as usize),
        (110_000, 110_000 / STEP_ROWS, 100_000 / STEP_ROWS),
        "rows deleted, steps that deleted, steps with the trace marked ({steps} steps in all)"
    );
    assert!(
        between.iter().all(|trace| stored(&connection, *trace)),
        "a trace stored between steps was evicted"
    );
    assert!(
        (100..110).all(|trace| stored(&connection, trace)),
        "the newer traces were kept"
    );
    assert_eq!(
        count(&connection, "SELECT count(*) FROM logs"),
        0,
        "the trace's logs went with it"
    );
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM resources WHERE service_name = 'big'"
        ),
        0
    );
    times.sort();
    let median = times[times.len() / 2];
    eprintln!(
        "{steps} steps, {marked_steps} marked: median {median:?}; storing 1,000 rows took {per_step_of_storing:?}"
    );
    // A step several times more costly per row than it is: measured against this run's own
    // storing, so it does not depend on the machine. Deleting 1,000 rows took 0.25 to 0.4 times
    // as long as storing 1,000 in four runs here, so a tenfold slower step fails.
    assert!(
        median < per_step_of_storing * STEP_COST_LIMIT,
        "the median step took {median:?}, storing as many rows took {per_step_of_storing:?}"
    );
    assert_consistent(&connection);
}

#[test]
fn a_span_for_a_trace_being_evicted_is_counted_and_not_stored() {
    let scratch = Scratch::new("late-span");
    let mut connection = store::open(&scratch.database()).expect("opens");
    store_spans(&mut connection, &spans_export(1, 0, 3_000, "svc", 10)).expect("stores");
    age_trace(
        &connection,
        1,
        NOW_MS - 200 * HOUR_MS,
        NOW_MS - 200 * HOUR_MS,
    );
    retention::step(&mut connection, &WEEK, NOW_MS, STEP_ROWS).expect("step");
    retention::evicting(&connection)
        .expect("evicting")
        .expect("a trace is part evicted");
    let spans_before = count(&connection, "SELECT count(*) FROM spans");

    let late = spans_export(1, 10_000, 5, "svc", 10);
    assert_eq!(
        store_spans(&mut connection, &late).expect("stores"),
        5,
        "the late spans are counted"
    );
    assert_eq!(
        count(&connection, "SELECT count(*) FROM spans"),
        spans_before,
        "a late span was stored"
    );

    drain(&mut connection, &WEEK, NOW_MS, 10);
    assert!(!stored(&connection, 1));
    assert_eq!(retention::evicting(&connection).expect("evicting"), None);
    // Once it is gone, the same trace id starts a new trace.
    assert_eq!(store_spans(&mut connection, &late).expect("stores"), 5);
    assert!(stored(&connection, 1));
    assert_eq!(count(&connection, "SELECT count(*) FROM spans"), 5);
    assert_consistent(&connection);
}

#[test]
fn a_resource_is_kept_while_anything_refers_to_it_and_deleted_with_its_last_row() {
    let scratch = Scratch::new("resources");
    let mut connection = store::open(&scratch.database()).expect("opens");
    // "shared" is used by an old trace and a new log; "old" only by the old trace and old logs.
    store_spans(&mut connection, &spans_export(1, 0, 3, "shared", 10)).expect("stores");
    store_spans(&mut connection, &spans_export(1, 3, 3, "old", 10)).expect("stores");
    store_logs(&mut connection, &logs_export(4, None, "old", 10)).expect("stores");
    age_trace(
        &connection,
        1,
        NOW_MS - 200 * HOUR_MS,
        NOW_MS - 200 * HOUR_MS,
    );
    age_new_logs(&connection, NOW_MS - 200 * HOUR_MS);
    store_logs(&mut connection, &logs_export(2, None, "shared", 10)).expect("stores");
    age_new_logs(&connection, NOW_MS - HOUR_MS);

    drain(&mut connection, &WEEK, NOW_MS, 10);

    let services = |connection: &Connection| -> Vec<String> {
        connection
            .prepare("SELECT service_name FROM resources ORDER BY service_name")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows")
    };
    assert_eq!(services(&connection), vec!["shared".to_owned()]);
    assert_consistent(&connection);
}

#[test]
fn free_pages_beyond_the_slack_go_back_to_the_file_system() {
    let scratch = Scratch::new("vacuum");
    let mut connection = store::open(&scratch.database()).expect("opens");
    let limits = filled(&mut connection, 400, 50);
    drain(&mut connection, &limits, NOW_MS, 1_000);
    // Then age takes everything.
    let later = NOW_MS + 200 * HOUR_MS;
    drain(&mut connection, &limits, later, 1_000);
    assert_eq!(
        count(&connection, "SELECT count(*) FROM spans")
            + count(&connection, "SELECT count(*) FROM logs"),
        0
    );
    let size = Size::read(&connection).expect("size");
    let excess_pages =
        (size.free_pages * size.page_size).saturating_sub(limits.max_bytes / 10) / size.page_size;
    let most_steps = excess_pages.div_ceil(retention::VACUUM_PAGES as u64);
    assert!(
        most_steps >= 2,
        "the test needs more than one vacuum step's worth of free pages"
    );
    let mut vacuum_steps = 0;
    while retention::work(&connection, &limits, later)
        .expect("work")
        .1
    {
        let step = retention::step(&mut connection, &limits, later, STEP_ROWS).expect("step");
        assert!(step.vacuumed_pages > 0, "a vacuum step returned nothing");
        assert!(step.vacuumed_pages <= retention::VACUUM_PAGES as u64);
        vacuum_steps += 1;
        assert!(
            vacuum_steps <= most_steps,
            "{vacuum_steps} vacuum steps for {excess_pages} pages, more than {most_steps}"
        );
    }
    // In WAL mode the file is truncated when the log is copied into it.
    connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .expect("checkpoint");
    let size = Size::read(&connection).expect("size");
    let slack = limits.max_bytes / 10;
    assert!(
        size.free_pages * size.page_size <= slack,
        "{} bytes free after vacuuming, more than the slack {slack}",
        size.free_pages * size.page_size
    );
    assert_eq!(
        std::fs::metadata(scratch.database()).expect("file").len(),
        size.file_bytes(),
        "the file did not shrink with its pages"
    );
    assert_consistent(&connection);
}

#[test]
fn a_traces_logs_are_evicted_with_it_and_other_logs_are_not() {
    let scratch = Scratch::new("trace-logs");
    let mut connection = store::open(&scratch.database()).expect("opens");
    store_spans(&mut connection, &spans_export(1, 0, 3, "svc", 10)).expect("stores");
    age_trace(
        &connection,
        1,
        NOW_MS - 200 * HOUR_MS,
        NOW_MS - 200 * HOUR_MS,
    );
    // Logs of the trace and logs of no trace, all written within the retention period.
    store_logs(&mut connection, &logs_export(4, Some(1), "svc", 10)).expect("stores");
    store_logs(&mut connection, &logs_export(2, None, "svc", 10)).expect("stores");
    age_new_logs(&connection, NOW_MS - HOUR_MS);

    drain(&mut connection, &WEEK, NOW_MS, 10);

    assert!(!stored(&connection, 1));
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM logs WHERE trace_id IS NOT NULL"
        ),
        0,
        "the trace's logs outlived it"
    );
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM logs WHERE trace_id IS NULL"
        ),
        2
    );
    assert_consistent(&connection);
}

// --- Store format policy -------------------------------------------------------------------

/// Every entry under `directory`, recursively: its kind, size, bytes (or link target) and
/// modification time, to show a refused start changed nothing at all.
fn snapshot(directory: &Path) -> std::collections::BTreeMap<String, String> {
    let mut entries = std::collections::BTreeMap::new();
    let mut stack = vec![directory.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read_dir") {
            let path = entry.expect("entry").path();
            let metadata = std::fs::symlink_metadata(&path).expect("metadata");
            let modified = metadata
                .modified()
                .expect("mtime")
                .duration_since(std::time::UNIX_EPOCH)
                .expect("after the epoch")
                .as_nanos();
            let name = path
                .strip_prefix(directory)
                .expect("inside")
                .display()
                .to_string();
            let description = if metadata.file_type().is_symlink() {
                format!(
                    "link {:?} {modified}",
                    std::fs::read_link(&path).expect("target")
                )
            } else if metadata.is_dir() {
                stack.push(path.clone());
                format!("dir {modified}")
            } else {
                let bytes = std::fs::read(&path).expect("read");
                format!("file {} {modified} {:?}", bytes.len(), bytes)
            };
            entries.insert(name, description);
        }
    }
    entries
}

/// A WAL-mode SQLite database at `directory/telemetry.sqlite` with this application id, a table
/// and committed rows still in its log: copied from a database another connection holds open,
/// as a crashed process leaves it.
fn wal_store(directory: &Path, application: i64) {
    let source = Scratch::new(&format!("wal-source-{application}"));
    let holder = Connection::open(source.database()).expect("open");
    holder
        .execute_batch(&format!(
            "PRAGMA application_id = {application}; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
             CREATE TABLE notes (body); INSERT INTO notes VALUES ('one'), ('two');"
        ))
        .expect("write");
    let [wal, shm, _] = store::companions(&source.database());
    let [to_wal, to_shm, _] = store::companions(&store::database_path(directory));
    for (from, to) in [
        (source.database(), store::database_path(directory)),
        (wal, to_wal.clone()),
        (shm, to_shm),
    ] {
        std::fs::copy(from, to).expect("copy");
    }
    assert!(
        std::fs::metadata(&to_wal).expect("wal").len() > 0,
        "the log holds the rows"
    );
    drop(holder);
}

/// A rollback-mode SQLite database with this application id and a journal file beside it.
fn journal_store(directory: &Path, application: i64) {
    let path = store::database_path(directory);
    Connection::open(&path)
        .expect("create")
        .execute_batch(&format!(
            "PRAGMA application_id = {application}; CREATE TABLE notes (body); INSERT INTO notes VALUES ('one');"
        ))
        .expect("schema");
    let [_, _, journal] = store::companions(&path);
    std::fs::write(journal, b"a journal that is not ours to touch\n".repeat(40)).expect("journal");
}

#[test]
fn a_file_that_is_not_ours_is_refused_and_nothing_in_the_directory_changes() {
    type Setup = fn(&Path);
    let cases: [(&str, Setup); 9] = [
        ("text", |dir| {
            std::fs::write(store::database_path(dir), "not a database ".repeat(20)).expect("write")
        }),
        ("short", |dir| {
            std::fs::write(store::database_path(dir), b"SQLite format 3\0abc").expect("write")
        }),
        ("bytes", |dir| {
            std::fs::write(
                store::database_path(dir),
                (0..4096u32).map(|n| (n * 7) as u8).collect::<Vec<_>>(),
            )
            .expect("write")
        }),
        ("wal-no-id", |dir| wal_store(dir, 0)),
        ("wal-other-id", |dir| wal_store(dir, 0x1234)),
        ("journal-no-id", |dir| journal_store(dir, 0)),
        ("journal-other-id", |dir| journal_store(dir, 0x1234)),
        // A format 1 store, never shipped: no application id.
        ("format-1", |dir| {
            Connection::open(store::database_path(dir))
                .expect("create")
                .execute_batch("PRAGMA user_version = 1; CREATE TABLE spans (id INTEGER PRIMARY KEY); INSERT INTO spans VALUES (1);")
                .expect("schema")
        }),
        ("neighbours", |dir| {
            wal_store(dir, 0x1234);
            std::fs::write(dir.join("notes.txt"), "keep").expect("write");
            std::fs::create_dir(dir.join("archive")).expect("dir");
        }),
    ];
    for (name, setup) in cases {
        let scratch = Scratch::new(&format!("not-ours-{name}"));
        setup(&scratch.0);
        let before = snapshot(&scratch.0);
        let error = store::open(&scratch.database()).expect_err("refused");
        assert!(error.contains("left as it is"), "{name}: {error}");
        assert_eq!(
            snapshot(&scratch.0),
            before,
            "{name}: the directory changed"
        );
    }
}

#[test]
fn links_and_directories_at_the_stores_names_are_refused_and_nothing_changes() {
    // The database name a link to a store of ours elsewhere, with its log and index.
    let outside = Scratch::new("link-target");
    {
        let mut connection = store::open(&outside.database()).expect("creates");
        store_spans(&mut connection, &spans_export(1, 0, 3, "svc", 10)).expect("stores");
        std::mem::forget(connection);
    }
    let scratch = Scratch::new("link-database");
    std::os::unix::fs::symlink(outside.database(), scratch.database()).expect("link");
    let (before, outside_before) = (snapshot(&scratch.0), snapshot(&outside.0));
    let error = store::open(&scratch.database()).expect_err("refused");
    assert!(error.contains("symbolic link"), "{error}");
    assert_eq!(snapshot(&scratch.0), before);
    assert_eq!(
        snapshot(&outside.0),
        outside_before,
        "the link's target changed"
    );
    // Each companion name a link to a sentinel.
    for index in 0..3 {
        let scratch = Scratch::new(&format!("link-companion-{index}"));
        let sentinel = scratch.0.join("sentinel");
        std::fs::write(&sentinel, "keep").expect("write");
        drop(store::open(&scratch.database()).expect("creates"));
        let companion = store::companions(&scratch.database())[index].clone();
        let _ = std::fs::remove_file(&companion);
        std::os::unix::fs::symlink(&sentinel, &companion).expect("link");
        let before = snapshot(&scratch.0);
        let error = store::open(&scratch.database()).expect_err("refused");
        assert!(error.contains("symbolic link"), "{error}");
        assert_eq!(snapshot(&scratch.0), before, "companion {index}");
    }
    // A directory at the database's name or a companion's.
    for name in [
        "telemetry.sqlite",
        "telemetry.sqlite-wal",
        "telemetry.sqlite-journal",
    ] {
        let scratch = Scratch::new(&format!("dir-{name}"));
        std::fs::create_dir(scratch.0.join(name)).expect("dir");
        std::fs::write(scratch.0.join(name).join("inside"), "keep").expect("write");
        let before = snapshot(&scratch.0);
        let error = store::open(&scratch.database()).expect_err("refused");
        assert!(error.contains("not a regular file"), "{name}: {error}");
        assert_eq!(snapshot(&scratch.0), before, "{name}");
    }
}

/// A store of this format holding a trace, then changed only as `change` says, closed.
fn store_then(name: &str, change: &str) -> Scratch {
    let scratch = Scratch::new(name);
    let mut connection = store::open(&scratch.database()).expect("creates");
    store_spans(&mut connection, &spans_export(1, 0, 3, "svc", 10)).expect("stores");
    connection.execute_batch(change).expect("change");
    drop(connection);
    scratch
}

fn inode(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).expect("metadata").ino()
}

#[test]
fn a_store_of_ours_that_differs_only_in_its_format_is_emptied_in_place() {
    for (name, version) in [("older", FORMAT - 1), ("newer", FORMAT + 1)] {
        let scratch = store_then(name, &format!("PRAGMA user_version = {version};"));
        let before = inode(&scratch.database());
        std::fs::write(scratch.0.join("notes.txt"), "keep").expect("write");
        let connection = store::open(&scratch.database()).expect("opens");
        assert_eq!(count(&connection, "PRAGMA user_version"), FORMAT, "{name}");
        assert_eq!(
            count(&connection, "SELECT count(*) FROM spans"),
            0,
            "{name}: the old store's spans are still there"
        );
        assert_eq!(
            count(&connection, "SELECT count(*) FROM traces"),
            0,
            "{name}"
        );
        assert_eq!(
            inode(&scratch.database()),
            before,
            "{name}: the file was replaced, not emptied"
        );
        assert_eq!(
            std::fs::read_to_string(scratch.0.join("notes.txt")).expect("kept"),
            "keep"
        );
        // Opened again, it is this format's store and is kept as it is.
        drop(connection);
        let mut connection = store::open(&scratch.database()).expect("reopens");
        store_spans(&mut connection, &spans_export(2, 0, 2, "svc", 10)).expect("stores");
        drop(connection);
        let connection = store::open(&scratch.database()).expect("reopens");
        assert_eq!(
            count(&connection, "SELECT count(*) FROM spans"),
            2,
            "{name}: a current store was emptied"
        );
    }
}

#[test]
fn a_store_of_ours_whose_tables_do_not_match_is_emptied_in_place() {
    for (name, change) in [
        ("extra-index", "CREATE INDEX extra ON logs (body);"),
        (
            "extra-table",
            "CREATE TABLE extra (x); CREATE VIEW extra_view AS SELECT * FROM extra; CREATE TRIGGER extra_trigger AFTER INSERT ON extra BEGIN SELECT 1; END;",
        ),
        ("missing-index", "DROP INDEX spans_start;"),
        ("missing-table", "DROP TABLE logs;"),
    ] {
        let scratch = store_then(name, change);
        let connection = store::open(&scratch.database()).expect("opens");
        assert_eq!(
            count(&connection, "SELECT count(*) FROM spans"),
            0,
            "{name}"
        );
        assert_eq!(
            count(
                &connection,
                "SELECT count(*) FROM sqlite_schema WHERE name LIKE 'extra%'"
            ),
            0,
            "{name}"
        );
    }
}

#[test]
fn a_store_of_ours_that_cannot_be_put_right_in_place_is_refused_and_left_alone() {
    // Incremental auto-vacuum is fixed when a file's first table is created.
    let scratch = Scratch::new("auto-vacuum");
    Connection::open(scratch.database())
        .expect("create")
        .execute_batch(&format!(
            "PRAGMA application_id = {APPLICATION_ID}; CREATE TABLE spans (x); INSERT INTO spans VALUES (1);"
        ))
        .expect("schema");
    let before = snapshot(&scratch.0);
    let error = store::open(&scratch.database()).expect_err("refused");
    assert!(error.contains("auto_vacuum"), "{error}");
    assert_eq!(snapshot(&scratch.0), before);
}

#[test]
fn every_state_a_first_start_can_be_cut_off_in_is_finished_by_the_next() {
    // Creation writes the application id, then WAL mode, then the tables and format.
    let steps: [&str; 4] = [
        "",
        "PRAGMA auto_vacuum = 2;",
        "PRAGMA auto_vacuum = 2; PRAGMA application_id = 1163416643;",
        "PRAGMA auto_vacuum = 2; PRAGMA application_id = 1163416643; PRAGMA journal_mode = WAL;",
    ];
    assert_eq!(APPLICATION_ID, 1_163_416_643);
    for (index, step) in steps.iter().enumerate() {
        let scratch = Scratch::new(&format!("cut-{index}"));
        if index == 0 {
            std::fs::write(scratch.database(), b"").expect("empty file");
        } else {
            Connection::open(scratch.database())
                .expect("create")
                .execute_batch(step)
                .expect("step");
        }
        let mut connection = store::open(&scratch.database()).expect("finishes");
        assert_eq!(
            count(&connection, "PRAGMA user_version"),
            FORMAT,
            "step {index}"
        );
        store_spans(&mut connection, &spans_export(1, 0, 2, "svc", 10)).expect("stores");
    }
}

/// A rollback journal SQLite would leave for a transaction that changed page 1 of a one-page
/// file, cut off after it wrote the new page and before it removed the journal: the journal
/// holds the old page, with the header and checksum SQLite writes (`pager.c`).
fn hot_journal(old_page: &[u8]) -> Vec<u8> {
    const SECTOR: usize = 512;
    let nonce: u32 = 0x5EED_1234;
    let mut journal = Vec::with_capacity(SECTOR + 8 + old_page.len());
    journal.extend_from_slice(&[0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
    for word in [1u32, nonce, 1, SECTOR as u32, old_page.len() as u32] {
        journal.extend_from_slice(&word.to_be_bytes());
    }
    journal.resize(SECTOR, 0);
    journal.extend_from_slice(&1u32.to_be_bytes());
    journal.extend_from_slice(old_page);
    let mut checksum = nonce;
    let mut at = old_page.len() - 200;
    while at > 0 {
        checksum = checksum.wrapping_add(u32::from(old_page[at]));
        at = at.saturating_sub(200);
    }
    journal.extend_from_slice(&checksum.to_be_bytes());
    journal
}

/// A first start cut off just after it wrote the application id, before SQLite removed the
/// journal of that write: the file carries the id, and the hot journal beside it holds the page
/// without it. Opening rolls the id back; the start must set it again, so the store it serves is
/// one the next start takes, with the export stored, twice over.
#[test]
fn a_first_start_cut_off_while_writing_the_application_id_is_finished_with_the_id() {
    let scratch = Scratch::new("cut-id");
    let database = scratch.database();
    {
        let connection = Connection::open(&database).expect("create");
        connection
            .execute_batch("PRAGMA auto_vacuum = 2;")
            .expect("auto vacuum");
    }
    let old_page = std::fs::read(&database).expect("page 1");
    assert_eq!(old_page.len(), 4096, "one page after auto-vacuum");
    {
        let connection = Connection::open(&database).expect("reopen");
        connection
            .pragma_update(None, "application_id", APPLICATION_ID)
            .expect("id");
    }
    let mut journal_name = database.as_os_str().to_owned();
    journal_name.push("-journal");
    std::fs::write(&journal_name, hot_journal(&old_page)).expect("journal");
    // The file as the cut-off start left it: the id in the header, the journal still hot.
    let header = std::fs::read(&database).expect("header");
    assert_eq!(
        i32::from_be_bytes([header[68], header[69], header[70], header[71]]),
        APPLICATION_ID as i32
    );
    let mut connection = store::open(&database).expect("finishes");
    assert_eq!(count(&connection, "PRAGMA application_id"), APPLICATION_ID);
    store_spans(&mut connection, &spans_export(1, 0, 2, "svc", 10)).expect("stores");
    drop(connection);
    for start in 0..2 {
        let connection = store::open(&database)
            .unwrap_or_else(|error| panic!("start {start} after the cut-off one: {error}"));
        assert_eq!(count(&connection, "PRAGMA application_id"), APPLICATION_ID);
        assert_eq!(count(&connection, "SELECT count(*) FROM spans"), 2);
    }
}

/// Every table's rows, and the schema, as text: what a store holds, to compare before and after.
fn dump(connection: &Connection) -> Vec<String> {
    let tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name != 'broken' ORDER BY name")
        .expect("tables")
        .query_map([], |row| row.get(0))
        .expect("names")
        .map(|name| name.expect("name"))
        .collect();
    let mut lines: Vec<String> = connection
        .prepare("SELECT type || ' ' || name || ' ' || coalesce(sql, '') FROM sqlite_schema ORDER BY type, name")
        .expect("schema")
        .query_map([], |row| row.get(0))
        .expect("rows")
        .map(|line| line.expect("line"))
        .collect();
    for table in tables {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM \"{table}\" ORDER BY rowid"))
            .or_else(|_| connection.prepare(&format!("SELECT * FROM \"{table}\"")))
            .expect("select");
        let columns = statement.column_count();
        let rows: Vec<String> = statement
            .query_map([], |row| {
                let values: Vec<String> = (0..columns)
                    .map(|index| {
                        format!("{:?}", row.get_ref(index).map(|value| format!("{value:?}")))
                    })
                    .collect();
                Ok(format!("{table}: {}", values.join(" | ")))
            })
            .expect("rows")
            .map(|row| row.expect("row"))
            .collect();
        lines.extend(rows);
    }
    lines
}

/// SQLite's own tables are not the collector's schema: `ANALYZE` on a store of this format adds
/// `sqlite_stat1`, and the store is kept as it is, its data with it, start after start.
#[test]
fn analyze_on_a_store_of_this_format_keeps_it_as_it_is() {
    let scratch = Scratch::new("analyzed");
    let mut connection = store::open(&scratch.database()).expect("creates");
    store_spans(&mut connection, &spans_export(1, 0, 20, "svc", 10)).expect("stores");
    connection.execute_batch("ANALYZE").expect("analyze");
    assert!(count(&connection, "SELECT count(*) FROM sqlite_stat1") > 0);
    let before = dump(&connection);
    drop(connection);
    for start in 0..2 {
        let connection = store::open(&scratch.database())
            .unwrap_or_else(|error| panic!("start {start}: {error}"));
        assert_eq!(dump(&connection), before, "start {start} changed the store");
    }
}

/// A store of ours in another format with an `AUTOINCREMENT` table, whose `sqlite_sequence` no
/// reset can drop, is emptied into this format, and the next starts take it as it is.
#[test]
fn a_store_of_another_format_with_an_autoincrement_table_is_emptied_once() {
    let scratch = Scratch::new("autoincrement");
    {
        let connection = store::open(&scratch.database()).expect("creates");
        connection
            .execute_batch(
                "CREATE TABLE counted (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT);
                 INSERT INTO counted (value) VALUES ('old');",
            )
            .expect("autoincrement table");
        connection
            .pragma_update(None, "user_version", FORMAT - 1)
            .expect("older format");
    }
    let connection = store::open(&scratch.database()).expect("empties it");
    assert_eq!(count(&connection, "PRAGMA user_version"), FORMAT);
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM sqlite_schema WHERE name = 'counted'"
        ),
        0
    );
    let after = dump(&connection);
    drop(connection);
    for start in 0..2 {
        let connection = store::open(&scratch.database())
            .unwrap_or_else(|error| panic!("start {start}: {error}"));
        assert_eq!(dump(&connection), after, "start {start} emptied it again");
    }
}

/// A reset that fails part way commits nothing: every row and table of the old store is as it
/// was, and the start fails. Here one table of the old store cannot be dropped (a virtual table of
/// a module this SQLite does not have), after others may have been.
#[test]
fn a_reset_that_fails_part_way_leaves_every_row_as_it_was() {
    let scratch = Scratch::new("reset-fails");
    {
        let mut connection = store::open(&scratch.database()).expect("creates");
        store_spans(&mut connection, &spans_export(1, 0, 20, "svc", 10)).expect("stores");
        connection
            .execute_batch(
                "PRAGMA writable_schema = ON;
                 INSERT INTO sqlite_schema (type, name, tbl_name, rootpage, sql)
                   VALUES ('table', 'broken', 'broken', 0, 'CREATE VIRTUAL TABLE broken USING nosuchmodule()');
                 PRAGMA writable_schema = OFF;",
            )
            .expect("an undroppable table");
        connection
            .pragma_update(None, "user_version", FORMAT - 1)
            .expect("older format");
    }
    let before = dump(&Connection::open(scratch.database()).expect("reader"));
    let error = store::open(&scratch.database()).expect_err("the reset fails");
    let after = dump(&Connection::open(scratch.database()).expect("reader"));
    assert_eq!(after, before, "the failed reset changed the store: {error}");
}

/// The last checks before a store is served (`store::servable`) and before a reset commits
/// (`store::mismatch`). No state the steps before them leave is known to fail them, so each is
/// checked directly, on a store of this format changed by hand in each way it must catch.
#[test]
fn the_last_checks_refuse_every_store_the_next_start_would_not_take() {
    let cases: [(&str, &str, bool); 8] = [
        ("as created", "", true),
        ("after ANALYZE", "ANALYZE;", true),
        (
            "another application id",
            "PRAGMA application_id = 1;",
            false,
        ),
        ("no application id", "PRAGMA application_id = 0;", false),
        (
            "another format",
            &format!("PRAGMA user_version = {};", FORMAT - 1),
            false,
        ),
        ("a missing table", "DROP TABLE logs;", false),
        ("an extra table", "CREATE TABLE extra (x);", false),
        (
            "an extra index",
            "CREATE INDEX extra ON logs (body);",
            false,
        ),
    ];
    for (case, change, servable) in cases {
        let scratch = Scratch::new("last-checks");
        drop(store::open(&scratch.database()).expect("creates"));
        let connection = Connection::open(scratch.database()).expect("opens");
        connection.execute_batch(change).expect(case);
        // The step every start ends with serves the connection only if it passes.
        let served = store::finish(Connection::open(scratch.database()).expect("opens"));
        assert_eq!(
            served.is_ok(),
            servable,
            "{case}: finish gave {:?}",
            served.err()
        );
        let format_ok = !change.contains("application_id");
        assert_eq!(
            store::servable(&connection).is_ok(),
            servable,
            "{case}: {:?}",
            store::servable(&connection)
        );
        // The reset's own check concerns the format and the schema only.
        assert_eq!(
            store::mismatch(&connection).expect("reads").is_none(),
            servable || !format_ok,
            "{case}"
        );
    }
    // Not in WAL mode: not servable.
    let scratch = Scratch::new("last-checks-journal");
    drop(store::open(&scratch.database()).expect("creates"));
    let connection = Connection::open(scratch.database()).expect("opens");
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .expect("rollback mode");
    assert!(store::servable(&connection).is_err());
    assert!(
        store::finish(connection).is_err(),
        "finish served a store in rollback mode"
    );
}

/// The reset's last step commits only a result of this format and rolls anything else back: a
/// transaction that leaves another format, a missing table or an extra table is refused and none
/// of it is committed; one that leaves the format is committed.
#[test]
fn the_reset_commits_only_a_store_of_this_format() {
    let cases = [
        (
            "another format",
            format!("PRAGMA user_version = {};", FORMAT - 1),
        ),
        ("a missing table", "DROP TABLE logs;".to_owned()),
        ("an extra table", "CREATE TABLE extra (x);".to_owned()),
    ];
    for (case, change) in &cases {
        let scratch = Scratch::new("reset-commit");
        drop(store::open(&scratch.database()).expect("creates"));
        let mut connection = Connection::open(scratch.database()).expect("opens");
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .expect("begins");
        // A row as well, so a commit would show in the data too.
        transaction
            .execute_batch(&format!("CREATE TABLE marker (x); {change}"))
            .expect(case);
        assert!(
            store::commit_checked(transaction, &scratch.database()).is_err(),
            "{case}: committed"
        );
        let after = Connection::open(scratch.database()).expect("reopens");
        assert!(
            store::mismatch(&after).expect("reads").is_none(),
            "{case}: the store changed"
        );
        let marker: i64 = after
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name = 'marker'",
                [],
                |row| row.get(0),
            )
            .expect("reads");
        assert_eq!(marker, 0, "{case}: the transaction was committed");
    }
    // A transaction that leaves this format is committed.
    let scratch = Scratch::new("reset-commit-ok");
    drop(store::open(&scratch.database()).expect("creates"));
    let mut connection = Connection::open(scratch.database()).expect("opens");
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("begins");
    transaction
        .execute_batch("INSERT INTO meta (key, value) VALUES ('marker', '1')")
        .expect("writes");
    store::commit_checked(transaction, &scratch.database()).expect("commits");
    let kept: i64 = Connection::open(scratch.database())
        .expect("reopens")
        .query_row(
            "SELECT count(*) FROM meta WHERE key = 'marker'",
            [],
            |row| row.get(0),
        )
        .expect("reads");
    assert_eq!(kept, 1);
}

/// Stamps never go back when the host's clock does: rows are stamped with the writer's
/// `IngestClock`, never earlier than its latest stamp, so logs stay in stamp order by rowid,
/// age eviction removes every expired log, and the expiry the status reads never says finished
/// while one remains. Two log exports and two traces with the clock set back 3 s between them,
/// then every moment from the first possible expiry to the last; and the clock restored from the
/// store after a restart.
#[test]
fn stamps_never_go_back_when_the_clock_does() {
    use store::IngestClock;
    let scratch = Scratch::new("clock-back");
    let mut connection = store::open(&scratch.database()).expect("opens");
    let mut clock = IngestClock::restore(&connection).expect("clock");
    let wall = NOW_MS - 200 * HOUR_MS;
    store::store_logs_at(
        &mut connection,
        &logs_export(2, None, "svc", 10),
        clock.stamp(wall),
    )
    .expect("first logs");
    store::store_spans_at(
        &mut connection,
        &spans_export(1, 0, 2, "svc", 10),
        clock.stamp(wall),
    )
    .expect("first trace");
    // The host's clock is set back 3 s.
    store::store_logs_at(
        &mut connection,
        &logs_export(2, None, "svc", 10),
        clock.stamp(wall - 3_000),
    )
    .expect("second logs");
    store::store_spans_at(
        &mut connection,
        &spans_export(2, 0, 2, "svc", 10),
        clock.stamp(wall - 3_000),
    )
    .expect("second trace");
    let stamps = |connection: &Connection, sql: &str| -> Vec<i64> {
        connection
            .prepare(sql)
            .expect("stamps")
            .query_map([], |row| row.get(0))
            .expect("rows")
            .map(|stamp| stamp.expect("stamp"))
            .collect()
    };
    // Two logs an export share their export's stamp; the next export's is later.
    let logs = stamps(&connection, "SELECT seen_ms FROM logs ORDER BY id");
    assert!(
        logs.windows(2).all(|pair| pair[0] <= pair[1]) && logs[1] < logs[2],
        "log stamps went back: {logs:?}"
    );
    let traces = stamps(&connection, "SELECT last_seen_ms FROM traces ORDER BY id");
    assert_eq!(traces.len(), 2, "both traces are stored");
    assert!(
        traces.windows(2).all(|pair| pair[0] < pair[1]),
        "trace stamps went back: {traces:?}"
    );
    // From 3 s before the first stamp could expire to well after: whenever a row has passed its
    // limit, retention has work, and once it has done it, none is left and the next expiry is
    // later.
    for offset in (-3_000..=1_000).step_by(250) {
        let now = clock.now(wall + WEEK.retention_ms + 1 + offset);
        let expired = |connection: &Connection| {
            count(
                connection,
                &format!(
                    "SELECT count(*) FROM logs WHERE seen_ms < {}",
                    now - WEEK.retention_ms
                ),
            ) + count(
                connection,
                &format!(
                    "SELECT count(*) FROM traces WHERE last_seen_ms < {}",
                    now - WEEK.retention_ms
                ),
            )
        };
        let (evict, _) = retention::work(&connection, &WEEK, now).expect("work");
        assert_eq!(
            evict,
            expired(&connection) > 0,
            "at {offset} ms: work and rows disagree"
        );
        // At most a step a row; a step that deletes nothing while work is owed fails the test.
        for _ in 0..10 {
            if !retention::work(&connection, &WEEK, now).expect("work").0 {
                break;
            }
            let step = retention::step(&mut connection, &WEEK, now, STEP_ROWS).expect("step");
            assert!(
                step.rows() > 0 || step.vacuumed_pages > 0,
                "at {offset} ms a step made no progress"
            );
        }
        assert!(
            !retention::work(&connection, &WEEK, now).expect("work").0,
            "at {offset} ms work was still owed after ten steps"
        );
        assert_eq!(
            expired(&connection),
            0,
            "at {offset} ms an expired row was left"
        );
        let next = retention::next_expiry_ms(&connection, &WEEK).expect("expiry");
        assert!(
            next.is_none_or(|at| at > now),
            "at {offset} ms the next expiry {next:?} has passed"
        );
    }
    assert_eq!(count(&connection, "SELECT count(*) FROM logs"), 0);
    // After a restart the clock starts from the store: it does not go back either.
    store::store_logs_at(
        &mut connection,
        &logs_export(1, None, "svc", 10),
        clock.stamp(wall + 10_000),
    )
    .expect("logs");
    drop(connection);
    let connection = store::open(&scratch.database()).expect("reopens");
    let mut restored = IngestClock::restore(&connection).expect("clock");
    assert!(restored.stamp(wall) > wall + 10_000);
}

// --- The writer and its clock ------------------------------------------------------------------

/// A wall clock the test sets, and the writer started with it, as `main` starts it.
struct Service {
    wall: std::sync::Arc<std::sync::atomic::AtomicI64>,
    shared: std::sync::Arc<store::Shared>,
    writer: Option<store::Writer>,
}

impl Service {
    fn start(data: &Path, limits: Limits, wall_ms: i64) -> Service {
        let wall = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(wall_ms));
        Service::start_with(data, limits, wall)
    }

    fn start_with(
        data: &Path,
        limits: Limits,
        wall: std::sync::Arc<std::sync::atomic::AtomicI64>,
    ) -> Service {
        let reading = wall.clone();
        let shared =
            std::sync::Arc::new(store::Shared::with_clock(std::sync::Arc::new(move || {
                reading.load(std::sync::atomic::Ordering::SeqCst)
            })));
        let writer = store::start(
            store::own(data).expect("owns"),
            4,
            std::sync::Arc::new(std::sync::Mutex::new(store::LossBook::default())),
            std::sync::Arc::new(store::MemoryRelease::default()),
            limits,
            shared.clone(),
        )
        .expect("starts");
        Service {
            wall,
            shared,
            writer: Some(writer),
        }
    }

    fn set_wall(&self, wall_ms: i64) {
        self.wall
            .store(wall_ms, std::sync::atomic::Ordering::SeqCst);
    }

    fn send(&self, export: store::Export) -> Result<usize, String> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.writer
            .as_ref()
            .expect("running")
            .sender()
            .send(store::Job {
                export,
                reply,
                maintenance_at_queue: 0,
            })
            .expect("queued");
        answer.blocking_recv().expect("answered")
    }

    /// Wait, at most `limit`, for the status to say maintenance is done.
    fn settle(&self, limit: std::time::Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < limit {
            if !self.shared.pending_now() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    }

    fn stop(mut self) {
        let writer = self.writer.take().expect("running");
        assert!(writer.close(Instant::now() + std::time::Duration::from_secs(5)));
    }
}

fn stamps(database: &Path, sql: &str) -> Vec<i64> {
    let connection = Connection::open(database).expect("opens");
    connection
        .prepare(sql)
        .expect("stamps")
        .query_map([], |row| row.get(0))
        .expect("rows")
        .map(|stamp| stamp.expect("stamp"))
        .collect()
}

/// The writer stamps with its clock: with the host's clock set back, each export's stamp is still
/// later than the one before it; when the clock reaches a moment one of those rows would have
/// expired at had it been stamped with the clock as read, the status says nothing is owed and no
/// expired row is stored; once rows expire they go; and after a restart, with the clock set
/// ahead and corrected before it, the next stamp is later than every stamp stored.
#[test]
fn the_writer_stamps_ages_and_restores_by_its_clock() {
    let scratch = Scratch::new("writer-clock");
    let wall = NOW_MS - 300 * HOUR_MS;
    let service = Service::start(&scratch.0, WEEK, wall);
    service
        .send(store::Export::Logs(logs_export(2, None, "svc", 10)))
        .expect("first logs");
    service.set_wall(wall - 3_000);
    service
        .send(store::Export::Logs(logs_export(2, None, "svc", 10)))
        .expect("second logs");
    let logs = stamps(&scratch.database(), "SELECT seen_ms FROM logs ORDER BY id");
    assert!(
        logs[0] == logs[1] && logs[1] < logs[2] && logs[2] == logs[3],
        "the writer's stamps: {logs:?}"
    );
    // The moment the second export would expire at, stamped with the clock as read.
    service.set_wall(wall - 3_000 + WEEK.retention_ms + 1);
    assert!(
        service.settle(std::time::Duration::from_secs(5)),
        "never settled"
    );
    // The writer has woken at least once at this time.
    std::thread::sleep(std::time::Duration::from_millis(600));
    // The writer ages rows by its clock: the wall clock, never before the latest stamp.
    let latest = stamps(&scratch.database(), "SELECT max(seen_ms) FROM logs")[0];
    let cutoff = (wall - 3_000 + WEEK.retention_ms + 1).max(latest) - WEEK.retention_ms;
    let expired = stamps(
        &scratch.database(),
        &format!("SELECT seen_ms FROM logs WHERE seen_ms < {cutoff}"),
    );
    // The check below is about rows that are stored: all four logs still are.
    assert_eq!(
        stamps(&scratch.database(), "SELECT seen_ms FROM logs").len(),
        4,
        "a log went before its time"
    );
    assert!(
        expired.is_empty() || service.shared.pending_now(),
        "the status says nothing is owed with expired logs stored: {expired:?}"
    );
    // Past both exports' expiry, every log goes.
    service.set_wall(wall + WEEK.retention_ms + 10);
    assert!(
        service.settle(std::time::Duration::from_secs(5)),
        "never settled"
    );
    std::thread::sleep(std::time::Duration::from_millis(600));
    assert!(
        service.settle(std::time::Duration::from_secs(5)),
        "never settled"
    );
    assert_eq!(
        stamps(&scratch.database(), "SELECT seen_ms FROM logs"),
        Vec::<i64>::new(),
        "expired logs were left"
    );
    // The clock set a day ahead, an export, the clock corrected, another: then a restart.
    let later = wall + WEEK.retention_ms + 20;
    service.set_wall(later + 24 * HOUR_MS);
    service
        .send(store::Export::Logs(logs_export(1, None, "svc", 10)))
        .expect("logs ahead");
    service.set_wall(later);
    service
        .send(store::Export::Spans(spans_export(3, 0, 1, "svc", 10)))
        .expect("trace after the correction");
    service.stop();
    let newest = stamps(
        &scratch.database(),
        "SELECT max(seen_ms) FROM logs UNION ALL SELECT max(last_seen_ms) FROM traces",
    )
    .into_iter()
    .max()
    .expect("stamps");
    assert!(newest > later + 24 * HOUR_MS, "{newest}");
    let service = Service::start(&scratch.0, WEEK, later + 1_000);
    service
        .send(store::Export::Logs(logs_export(1, None, "svc", 10)))
        .expect("logs after the restart");
    let after = stamps(&scratch.database(), "SELECT max(seen_ms) FROM logs")[0];
    assert!(
        after > newest,
        "after a restart the writer stamped {after}, before the stored {newest}"
    );
    service.stop();
}

/// Retention ages rows by the writer's clock, not the clock as read: with the host's clock set
/// ahead, an export taken at that time, and the clock corrected before eviction could run (a
/// write lock from outside holding it off), the log that expired by the writer's clock still goes
/// and the status then says nothing is owed.
#[test]
fn a_corrected_clock_does_not_postpone_eviction() {
    let scratch = Scratch::new("writer-cutoff");
    let wall = NOW_MS - 300 * HOUR_MS;
    let service = Service::start(&scratch.0, WEEK, wall);
    service
        .send(store::Export::Logs(logs_export(1, None, "svc", 10)))
        .expect("logs");
    let outside = Connection::open(scratch.database()).expect("opens");
    outside.execute_batch("BEGIN IMMEDIATE").expect("locks");
    // The clock a week and a second ahead: the log has expired. An empty export takes a stamp
    // then; eviction cannot write.
    service.set_wall(wall + WEEK.retention_ms + 1_000);
    service
        .send(store::Export::Logs(Logs::default()))
        .expect("an empty export");
    service.set_wall(wall + 2_000);
    // An attempt that read the clock while it was ahead waits `BUSY_TIMEOUT` for the lock and
    // fails; the lock is released only after that, so every attempt that can succeed reads the
    // corrected clock.
    std::thread::sleep(store::BUSY_TIMEOUT * 3);
    outside.execute_batch("COMMIT").expect("unlocks");
    drop(outside);
    let started = Instant::now();
    while started.elapsed() < std::time::Duration::from_secs(10)
        && !stamps(&scratch.database(), "SELECT seen_ms FROM logs").is_empty()
    {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(
        stamps(&scratch.database(), "SELECT seen_ms FROM logs"),
        Vec::<i64>::new(),
        "the log expired by the writer's clock was left"
    );
    assert!(
        service.settle(std::time::Duration::from_secs(5)),
        "never settled"
    );
    service.stop();
}

/// Size eviction takes what arrived first, by stamp, after the host's clock was set ahead and
/// corrected: the reviewer's case. Logs, then three traces past a 1 MiB bound: the logs go first,
/// then the oldest traces, and the newest stays, as with a clock that was never wrong (the frozen
/// clock kept every log and evicted each new trace).
#[test]
fn eviction_by_arrival_holds_after_the_clock_is_corrected() {
    let scratch = Scratch::new("writer-frozen");
    let limits = Limits {
        max_bytes: 1 << 20,
        retention_ms: WEEK.retention_ms,
    };
    let wall = NOW_MS - 300 * HOUR_MS;
    let service = Service::start(&scratch.0, limits, wall + 24 * HOUR_MS);
    service
        .send(store::Export::Logs(Logs::default()))
        .expect("an empty export a day ahead");
    service.set_wall(wall);
    for _ in 0..5 {
        service
            .send(store::Export::Logs(logs_export(100, None, "logs", 800)))
            .expect("logs");
    }
    for trace in 1..=3 {
        service
            .send(store::Export::Spans(spans_export(
                trace, 0, 600, "traces", 600,
            )))
            .expect("trace");
    }
    assert!(
        service.settle(std::time::Duration::from_secs(10)),
        "never settled"
    );
    let connection = Connection::open(scratch.database()).expect("opens");
    let logs = count(&connection, "SELECT count(*) FROM logs");
    let kept: Vec<u64> = (1..=3)
        .filter(|trace| stored(&connection, *trace))
        .collect();
    // Something was evicted, the oldest first: the logs, then the oldest trace.
    assert_eq!(
        logs, 0,
        "the older logs were kept while traces {kept:?} are stored"
    );
    assert!(!kept.contains(&1), "the oldest trace was kept: {kept:?}");
    // What is left is what arrived last: the newest trace, and every trace after the oldest kept.
    assert_eq!(
        kept.last(),
        Some(&3),
        "the newest trace was evicted: {kept:?}"
    );
    assert_eq!(
        kept,
        (kept[0]..=3).collect::<Vec<_>>(),
        "traces {kept:?} are stored: not the newest ones"
    );
    drop(connection);
    service.stop();
}
