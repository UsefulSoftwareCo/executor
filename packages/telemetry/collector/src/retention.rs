//! Retention: the store keeps telemetry for `--retention-hours` and within `--max-store-mb`.
//!
//! The writer thread runs it in steps between exports, as its own work: it is never queued
//! behind or in front of exports on the export queue. Each step is one transaction that deletes
//! at most `STEP_ROWS` spans and logs, so no step holds the writer for long, whatever one trace
//! holds.
//!
//! - **Age.** A trace whose `last_seen_ms` (when a span of it was last written) is older than the
//!   retention period is evicted, as is a log whose `seen_ms` is.
//! - **Size.** When the store's pages in use pass the bound, it is draining until they are at or
//!   below `LOW_WATER_PERCENT` of it. Draining evicts what arrived first: the trace with the
//!   lowest rowid or the log with the lowest rowid, whichever arrived earlier by `first_seen_ms`
//!   and `seen_ms`. The draining flag is kept in `meta`, so a drain continues after a restart.
//! - **A trace is evicted whole, over as many steps as it needs.** Its rowid is kept in `meta`
//!   under `evicting` until its last span and log are gone, so at most one trace is part deleted
//!   at any commit. Queries treat that trace as gone. A span that arrives for it is counted and
//!   acknowledged but not written: it belongs to a trace being evicted. Its logs are deleted with
//!   it.
//! - **Resources** are deleted in the same step that deletes the last span or log that refers to
//!   one.
//! - **Freed pages** go back to the file system with `PRAGMA incremental_vacuum` once more than
//!   `FREE_SLACK_PERCENT` of the bound is free, a bounded number of pages at a time.

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::store::remove_resource_if_unreferenced;

/// The most spans and logs one step deletes. Measured on a 1 GiB store, with the write-ahead log
/// checkpoints that fall inside steps, a step of this size held the writer 14 ms at the median
/// and under 200 ms at most (`README.md`, Retention).
pub const STEP_ROWS: usize = 1_000;
/// The most pages one vacuum step returns to the file system.
pub const VACUUM_PAGES: i64 = 512;
/// A drain ends once the pages in use are at or below this share of the bound.
pub const LOW_WATER_PERCENT: u64 = 90;
/// Free pages up to this share of the bound stay in the file for new rows; more go back to the
/// file system.
pub const FREE_SLACK_PERCENT: u64 = 10;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// The most bytes of pages in use the store keeps.
    pub max_bytes: u64,
    /// How long a trace or log is kept after it was last written, in milliseconds.
    pub retention_ms: i64,
}

impl Limits {
    pub fn low_water_bytes(&self) -> u64 {
        self.max_bytes / 100 * LOW_WATER_PERCENT
    }

    fn free_slack_bytes(&self) -> u64 {
        self.max_bytes / 100 * FREE_SLACK_PERCENT
    }
}

/// The store's size, from two header fields: free pages are part of the file but not in use.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Size {
    pub page_size: u64,
    pub pages: u64,
    pub free_pages: u64,
}

impl Size {
    pub fn read(connection: &Connection) -> rusqlite::Result<Size> {
        let pragma = |name: &str| -> rusqlite::Result<u64> {
            connection.query_row(&format!("PRAGMA {name}"), [], |row| {
                row.get::<_, i64>(0).map(|value| value.max(0) as u64)
            })
        };
        Ok(Size {
            page_size: pragma("page_size")?,
            pages: pragma("page_count")?,
            free_pages: pragma("freelist_count")?,
        })
    }

    pub fn used_bytes(&self) -> u64 {
        (self.pages - self.free_pages.min(self.pages)) * self.page_size
    }

    pub fn file_bytes(&self) -> u64 {
        self.pages * self.page_size
    }

    fn free_bytes(&self) -> u64 {
        self.free_pages * self.page_size
    }
}

/// What one step did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Step {
    /// Spans deleted.
    pub spans: u64,
    /// Logs deleted, with their trace or on their own.
    pub logs: u64,
    /// Traces whose eviction this step finished.
    pub traces: u64,
    /// Pages returned to the file system.
    pub vacuumed_pages: u64,
}

impl Step {
    pub fn rows(&self) -> u64 {
        self.spans + self.logs
    }
}

const EVICTING: &str = "evicting";
const DRAINING: &str = "draining";

/// The rowid of the trace being evicted, if any. Queries leave it out.
pub fn evicting(connection: &Connection) -> rusqlite::Result<Option<i64>> {
    connection
        .prepare_cached("SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'evicting'")?
        .query_row([], |row| row.get(0))
        .optional()
}

pub fn draining(connection: &Connection) -> rusqlite::Result<bool> {
    Ok(connection
        .prepare_cached("SELECT value FROM meta WHERE key = 'draining'")?
        .query_row([], |row| row.get::<_, String>(0))
        .optional()?
        .is_some_and(|value| value == "1"))
}

fn set_meta(transaction: &Transaction, key: &str, value: Option<String>) -> rusqlite::Result<()> {
    match value {
        Some(value) => transaction
            .prepare_cached(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            )?
            .execute(params![key, value])?,
        None => transaction
            .prepare_cached("DELETE FROM meta WHERE key = ?1")?
            .execute([key])?,
    };
    Ok(())
}

/// What to delete next.
enum Victim {
    Trace(i64),
    /// Logs from the oldest up to and including this rowid.
    LogsThrough(i64),
}

/// What retention has to do now: whether to evict (a trace part evicted, a drain, the bound
/// passed, an expired trace or log) and whether to return free pages. Reads only index ends and
/// header fields.
pub fn work(
    connection: &Connection,
    limits: &Limits,
    now_ms: i64,
) -> rusqlite::Result<(bool, bool)> {
    let size = Size::read(connection)?;
    let vacuum = size.free_bytes() > limits.free_slack_bytes();
    let cutoff_ms = now_ms - limits.retention_ms;
    let evict = evicting(connection)?.is_some()
        || draining(connection)?
        || size.used_bytes() > limits.max_bytes
        || expired_trace(connection, cutoff_ms)?.is_some()
        || oldest_log(connection)?.is_some_and(|(_, seen)| seen < cutoff_ms);
    Ok((evict, vacuum))
}

/// The first time, in ms, at which a stored trace or log is older than the retention period:
/// age eviction is owed from then. `None` when the store holds neither. Reads two index ends.
pub fn next_expiry_ms(connection: &Connection, limits: &Limits) -> rusqlite::Result<Option<i64>> {
    let trace: Option<i64> = connection
        .prepare_cached("SELECT min(last_seen_ms) FROM traces")?
        .query_row([], |row| row.get(0))?;
    let log = oldest_log(connection)?.map(|(_, seen)| seen);
    // Expired once `seen < now - retention`, so from `seen + retention + 1`.
    Ok([trace, log]
        .into_iter()
        .flatten()
        .min()
        .map(|seen| seen.saturating_add(limits.retention_ms).saturating_add(1)))
}

fn expired_trace(connection: &Connection, cutoff_ms: i64) -> rusqlite::Result<Option<i64>> {
    connection
        .prepare_cached(
            "SELECT id FROM traces WHERE last_seen_ms < ?1 ORDER BY last_seen_ms, id LIMIT 1",
        )?
        .query_row([cutoff_ms], |row| row.get(0))
        .optional()
}

/// The first log written that is still stored: its rowid and `seen_ms`.
fn oldest_log(connection: &Connection) -> rusqlite::Result<Option<(i64, i64)>> {
    connection
        .prepare_cached("SELECT id, seen_ms FROM logs ORDER BY id LIMIT 1")?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
}

/// The first trace written that is still stored: its rowid and `first_seen_ms`.
fn oldest_trace(connection: &Connection) -> rusqlite::Result<Option<(i64, i64)>> {
    connection
        .prepare_cached("SELECT id, first_seen_ms FROM traces ORDER BY id LIMIT 1")?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
}

/// The last rowid of the run of at most `limit` logs from the oldest whose `seen_ms` is below
/// `before_ms`, if the oldest log is.
fn logs_before(
    connection: &Connection,
    before_ms: i64,
    limit: usize,
) -> rusqlite::Result<Option<i64>> {
    let mut statement =
        connection.prepare_cached("SELECT id, seen_ms FROM logs ORDER BY id LIMIT ?1")?;
    let mut rows = statement.query([limit as i64])?;
    let mut last = None;
    while let Some(row) = rows.next()? {
        let (id, seen): (i64, i64) = (row.get(0)?, row.get(1)?);
        if seen >= before_ms {
            break;
        }
        last = Some(id);
    }
    Ok(last)
}

/// Run one retention step: one transaction deleting at most `budget` spans and logs, then, when
/// nothing is left to delete and more than the slack is free, one vacuum of at most
/// `VACUUM_PAGES` pages.
pub fn step(
    connection: &mut Connection,
    limits: &Limits,
    now_ms: i64,
    budget: usize,
) -> rusqlite::Result<Step> {
    let mut done = Step::default();
    let cutoff_ms = now_ms - limits.retention_ms;
    let transaction = connection.transaction()?;
    let mut draining = draining(&transaction)?;
    let was_draining = draining;
    let mut resources = BTreeSet::new();
    let mut left = budget as i64;
    if !draining && Size::read(&transaction)?.used_bytes() > limits.max_bytes {
        draining = true;
    }
    while left > 0 {
        let victim = match evicting(&transaction)? {
            Some(trace) => Victim::Trace(trace),
            None => match next_victim(&transaction, limits, cutoff_ms, &mut draining, left)? {
                Some(victim) => victim,
                None => break,
            },
        };
        match victim {
            Victim::Trace(trace) => {
                let finished =
                    evict_trace(&transaction, trace, &mut left, &mut done, &mut resources)?;
                if finished {
                    done.traces += 1;
                }
            }
            Victim::LogsThrough(last) => {
                let mut statement = transaction
                    .prepare_cached("DELETE FROM logs WHERE id <= ?1 RETURNING resource")?;
                let mut rows = statement.query([last])?;
                while let Some(row) = rows.next()? {
                    resources.insert(row.get::<_, i64>(0)?);
                    done.logs += 1;
                    left -= 1;
                }
            }
        }
    }
    for resource in resources {
        remove_resource_if_unreferenced(&transaction, resource)?;
    }
    if draining != was_draining {
        set_meta(&transaction, DRAINING, draining.then(|| "1".to_owned()))?;
    }
    transaction.commit()?;
    if done.rows() == 0 {
        done.vacuumed_pages = vacuum(connection, limits)?;
    }
    Ok(done)
}

/// Choose what to evict next, when no trace is part evicted: an expired trace, then expired logs,
/// then, while draining, what arrived first. Ends the drain at the low-water mark or when the
/// store holds nothing more to evict.
fn next_victim(
    transaction: &Transaction,
    limits: &Limits,
    cutoff_ms: i64,
    draining: &mut bool,
    left: i64,
) -> rusqlite::Result<Option<Victim>> {
    if let Some(trace) = expired_trace(transaction, cutoff_ms)? {
        return Ok(Some(Victim::Trace(trace)));
    }
    if let Some(last) = logs_before(transaction, cutoff_ms, left as usize)? {
        return Ok(Some(Victim::LogsThrough(last)));
    }
    if !*draining {
        return Ok(None);
    }
    if Size::read(transaction)?.used_bytes() <= limits.low_water_bytes() {
        *draining = false;
        return Ok(None);
    }
    let trace = oldest_trace(transaction)?;
    let log = oldest_log(transaction)?;
    Ok(match (trace, log) {
        (None, None) => {
            *draining = false;
            None
        }
        (Some((trace, _)), None) => Some(Victim::Trace(trace)),
        // Logs that arrived before the oldest trace, then the trace. Traces go by their first
        // arrival, logs by theirs; each export has its own stamp (`store::IngestClock`), so a
        // trace and a log never share one.
        (Some((trace, trace_seen)), Some((_, log_seen))) if trace_seen < log_seen => {
            Some(Victim::Trace(trace))
        }
        (Some((_, trace_seen)), Some(_)) => {
            logs_before(transaction, trace_seen, left as usize)?.map(Victim::LogsThrough)
        }
        (None, Some(_)) => {
            logs_before(transaction, i64::MAX, left as usize)?.map(Victim::LogsThrough)
        }
    })
}

/// Delete up to `left` of a trace's spans, then of its logs, marking it as being evicted. Returns
/// true when nothing of it is left and its row is deleted too.
fn evict_trace(
    transaction: &Transaction,
    trace: i64,
    left: &mut i64,
    done: &mut Step,
    resources: &mut BTreeSet<i64>,
) -> rusqlite::Result<bool> {
    let Some(trace_id) = transaction
        .prepare_cached("SELECT trace_id FROM traces WHERE id = ?1")?
        .query_row([trace], |row| row.get::<_, Vec<u8>>(0))
        .optional()?
    else {
        // The mark outlived its trace; there is nothing to finish.
        set_meta(transaction, EVICTING, None)?;
        return Ok(false);
    };
    set_meta(transaction, EVICTING, Some(trace.to_string()))?;
    let wanted = *left;
    let mut deleted = 0;
    {
        let mut statement = transaction.prepare_cached(
            "DELETE FROM spans WHERE id IN (SELECT id FROM spans WHERE trace = ?1 LIMIT ?2) RETURNING resource",
        )?;
        let mut rows = statement.query(params![trace, wanted])?;
        while let Some(row) = rows.next()? {
            resources.insert(row.get::<_, i64>(0)?);
            deleted += 1;
        }
    }
    done.spans += deleted as u64;
    *left -= deleted;
    if deleted == wanted {
        return Ok(false);
    }
    let wanted = *left;
    let mut deleted = 0;
    {
        let mut statement = transaction.prepare_cached(
            "DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE trace_id = ?1 LIMIT ?2) RETURNING resource",
        )?;
        let mut rows = statement.query(params![trace_id, wanted])?;
        while let Some(row) = rows.next()? {
            resources.insert(row.get::<_, i64>(0)?);
            deleted += 1;
        }
    }
    done.logs += deleted as u64;
    *left -= deleted;
    if deleted == wanted {
        return Ok(false);
    }
    transaction
        .prepare_cached("DELETE FROM traces WHERE id = ?1")?
        .execute([trace])?;
    set_meta(transaction, EVICTING, None)?;
    Ok(true)
}

/// Return up to `VACUUM_PAGES` free pages to the file system when more than the slack is free.
fn vacuum(connection: &Connection, limits: &Limits) -> rusqlite::Result<u64> {
    let size = Size::read(connection)?;
    let excess = size.free_bytes().saturating_sub(limits.free_slack_bytes());
    if excess == 0 || size.page_size == 0 {
        return Ok(0);
    }
    let pages = (excess.div_ceil(size.page_size) as i64).min(VACUUM_PAGES);
    // Each step of the statement frees one page, so it runs until it has no more rows. The file
    // can shrink by a little more: pointer-map pages it no longer needs go too.
    let mut statement = connection.prepare(&format!("PRAGMA incremental_vacuum({pages})"))?;
    let mut rows = statement.query([])?;
    let mut freed = 0;
    while rows.next()?.is_some() {
        freed += 1;
    }
    Ok(freed)
}

/// The write-ahead log's size on disk, or 0 when there is none.
pub fn wal_bytes(database: &Path) -> u64 {
    let mut wal = database.as_os_str().to_owned();
    wal.push("-wal");
    std::fs::metadata(wal).map_or(0, |metadata| metadata.len())
}
