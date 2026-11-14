//! The query routes' answers, with Motel's response shapes, limits, clamping and lookback rules
//! (`motel:src/httpListPolicy.ts`, `domain.ts`, `TelemetryStore.ts` at the pinned revision).
//! `README.md` lists where they differ.
//!
//! Each answer runs on a reader (`readers.rs`) in one read transaction and writes its JSON as it
//! reads rows. A trace's answer first reads a skeleton of the trace, at most `SKELETON_BYTES`, to
//! put its spans in tree order, then reads and writes one span at a time; a trace whose skeleton
//! would take more is answered with its first spans and says so. A 100,000-span trace's skeleton
//! is about 10 MB. Lists hold one row at a time
//! and stop at their limit. Each row is built as a JSON value with its resource's attributes
//! merged in; resources are kept for the answer up to `RESOURCE_CACHE_BYTES` of stored text.
//!
//! Loops over rows or a trace's nodes check the deadline, the read gate and the caller every
//! `CHECK_ROWS`, as SQLite's progress handler cannot reach them; text matching checks within
//! each text (`text.rs`).
//!
//! The trace being evicted (`retention::evicting`) is left out of every answer, so no answer
//! holds part of a trace that is being deleted.

use std::borrow::Cow;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde_json::{Value, json};

use crate::readers::{Out, Stop};
use crate::text::TextMatch;

// --- Parameters ------------------------------------------------------------------------------

/// A list route's limits, as Motel's `httpListPolicy.ts` sets them.
#[derive(Clone, Copy)]
pub struct Bounds {
    pub default_limit: i64,
    pub max_limit: i64,
}

pub const TRACE_LIST: Bounds = Bounds {
    default_limit: 20,
    max_limit: 100,
};
pub const SPAN_LIST: Bounds = Bounds {
    default_limit: 100,
    max_limit: 500,
};
pub const LOG_LIST: Bounds = Bounds {
    default_limit: 100,
    max_limit: 500,
};
/// The query parameters each route of Motel's declared, which it accepted once each.
pub const TRACES_PARAMETERS: &[&str] = &["service", "limit", "lookback", "cursor"];
pub const STATS_PARAMETERS: &[&str] = &[
    "groupBy",
    "agg",
    "service",
    "operation",
    "status",
    "minDurationMs",
    "lookback",
    "limit",
];
pub const TRACE_LOGS_PARAMETERS: &[&str] = &["lookback", "limit", "cursor"];
pub const SPAN_SEARCH_PARAMETERS: &[&str] = &[
    "service",
    "traceId",
    "operation",
    "parentOperation",
    "status",
    "lookback",
    "limit",
];
pub const LOGS_PARAMETERS: &[&str] = &[
    "service", "severity", "traceId", "spanId", "body", "lookback", "limit", "cursor",
];

pub const TRACE_STATS: Bounds = Bounds {
    default_limit: 20,
    max_limit: 100,
};
/// Every list's default lookback, and the longest allowed: 60 minutes and 7 days.
const DEFAULT_LOOKBACK_MINUTES: i64 = 60;
const MAX_LOOKBACK_MINUTES: i64 = 7 * 24 * 60;
/// `/api/services` lists services with spans or logs this recent, as Motel's
/// `traceLookbackMinutes` default.
const SERVICES_LOOKBACK_MINUTES: i64 = 1440;

/// A request's query string, decoded as `URLSearchParams` decodes it.
pub struct Query {
    pairs: Vec<(String, String)>,
}

impl Query {
    pub fn parse(raw: Option<&str>) -> Query {
        let pairs = raw
            .unwrap_or("")
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| {
                let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                (form_decode(key), form_decode(value))
            })
            .collect();
        Query { pairs }
    }

    /// Whether the request is one Motel's route schema accepted: none of `declared` given twice,
    /// a `limit` that is a number, and the values Motel checked (`status`, `minDurationMs`) of
    /// the right kind. Motel answered anything else 400 with an empty body.
    pub fn is_valid(&self, declared: &[&str]) -> bool {
        let repeated = declared
            .iter()
            .any(|name| self.pairs.iter().filter(|(key, _)| key == name).count() > 1);
        let status_ok = !declared.contains(&"status")
            || self
                .get("status")
                .is_none_or(|status| matches!(status, "ok" | "error"));
        let duration_ok = !declared.contains(&"minDurationMs")
            || self.get("minDurationMs").is_none_or(is_decimal);
        !repeated && self.limit_is_valid() && status_ok && duration_ok
    }

    /// The first value of `name`, as `URLSearchParams.get` returns it.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// A non-empty value of `name`: Motel treats an empty filter as no filter.
    fn filter(&self, name: &str) -> Option<&str> {
        self.get(name).filter(|value| !value.is_empty())
    }

    /// `attr.<key>=<value>` filters; for a key given twice, the last value.
    fn attributes(&self) -> Vec<(String, String)> {
        let mut filters: Vec<(String, String)> = Vec::new();
        for (key, value) in &self.pairs {
            let Some(name) = key.strip_prefix("attr.") else {
                continue;
            };
            match filters.iter_mut().find(|(existing, _)| existing == name) {
                Some(entry) => entry.1 = value.clone(),
                None => filters.push((name.to_owned(), value.clone())),
            }
        }
        filters
    }

    /// Whether `limit`, when given, is a number Motel's route schema accepted: an optional sign,
    /// digits with an optional fraction, and an optional exponent. Motel answered anything else
    /// 400 with an empty body.
    pub fn limit_is_valid(&self) -> bool {
        self.get("limit").is_none_or(is_decimal)
    }

    /// The limit: a leading whole number as `parseInt` reads it, positive, else the default;
    /// then clamped to the route's maximum.
    pub fn limit(&self, bounds: Bounds) -> i64 {
        let parsed = self
            .get("limit")
            .and_then(parse_int)
            .filter(|limit| *limit > 0);
        parsed
            .unwrap_or(bounds.default_limit)
            .clamp(1, bounds.max_limit)
    }

    /// The lookback in minutes: `<n>m`, `<n>h` or `<n>d`, positive, else 60; at most 7 days.
    pub fn lookback_minutes(&self) -> i64 {
        // Motel: `/^(\d+)([mhd])$/i` on the trimmed value, the digits read as a JavaScript number
        // (a double), a positive finite amount, then the minutes clamped to 1..7 days.
        let parsed = self.get("lookback").and_then(|value| {
            let value = value.trim_matches(is_ecmascript_space);
            // The unit is the last byte and must be ASCII, so the digits end on a character
            // boundary whatever the value holds.
            let (&unit, digits) = value.as_bytes().split_last()?;
            let factor = match unit.to_ascii_lowercase() {
                b'd' => 1440.0,
                b'h' => 60.0,
                b'm' => 1.0,
                _ => return None,
            };
            if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
                return None;
            }
            let amount: f64 = std::str::from_utf8(digits).ok()?.parse().ok()?;
            if !amount.is_finite() || amount <= 0.0 {
                return None;
            }
            Some(amount * factor)
        });
        match parsed {
            Some(minutes) => minutes.clamp(1.0, MAX_LOOKBACK_MINUTES as f64) as i64,
            None => DEFAULT_LOOKBACK_MINUTES,
        }
    }
}

/// What ECMAScript's `String.prototype.trim` removes: its white space (Unicode `Zs`, tab, vertical
/// tab, form feed, no-break space, U+FEFF) and line terminators. Unlike Rust's `trim`, it takes
/// U+FEFF and leaves U+0085.
fn is_ecmascript_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `[+-]?(digits|digits.digits|.digits)([eE][+-]?digits)?`, `Infinity` with a sign, or `NaN`:
/// what Motel's schema accepted, found by comparing the two (`collector-diff`).
fn is_decimal(text: &str) -> bool {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" || text == "NaN" {
        return true;
    }
    let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, Some(exponent)),
        None => (unsigned, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    let mantissa_ok = match mantissa.split_once('.') {
        Some((whole, fraction)) => (whole.is_empty() || digits(whole)) && digits(fraction),
        None => digits(mantissa),
    };
    let exponent_ok = exponent
        .is_none_or(|exponent| digits(exponent.strip_prefix(['+', '-']).unwrap_or(exponent)));
    mantissa_ok && exponent_ok
}

/// `parseInt(value, 10)`: optional whitespace and sign, then the leading digits. Digits whose
/// value a double cannot hold (about 309 or more) are JavaScript's `Infinity`, which Motel did not
/// take as a limit: `None`, as for no digits.
fn parse_int(value: &str) -> Option<i64> {
    let value = value.trim_start();
    let (negative, rest) = match value.as_bytes().first() {
        Some(b'-') => (true, &value[1..]),
        Some(b'+') => (false, &value[1..]),
        _ => (false, value),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    // A number too large for an i64 is far over every maximum, unless it is too large for a
    // double, as JavaScript reads it, too.
    let number = match digits.parse::<i64>() {
        Ok(number) => number,
        Err(_) if digits.parse::<f64>().is_ok_and(f64::is_finite) => i64::MAX,
        Err(_) => return None,
    };
    Some(if negative { -number } else { number })
}

/// application/x-www-form-urlencoded decoding: `+` is a space, `%XX` a byte, anything else
/// itself; invalid UTF-8 becomes U+FFFD.
fn form_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => decoded.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                match hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                    Some(byte) => {
                        decoded.push(byte);
                        index += 2;
                    }
                    None => decoded.push(b'%'),
                }
            }
            byte => decoded.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn format_lookback(minutes: i64) -> String {
    if minutes % 1440 == 0 {
        format!("{}d", minutes / 1440)
    } else if minutes % 60 == 0 {
        format!("{}h", minutes / 60)
    } else {
        format!("{minutes}m")
    }
}

/// Why a list refuses a cursor: one that does not decode, of the other kind of list, or with a
/// number out of range. A well-formed position is taken on any list of its kind.
const CURSOR_MALFORMED: &str =
    "The cursor is not a position in this kind of list; start the list again without it";

/// A list's cursor split into its parts after `kind`; `Ok(None)` when the request has none or an
/// empty one.
fn cursor_parts<'a>(
    text: Option<&'a str>,
    kind: &str,
    count: usize,
) -> Result<Option<Vec<&'a str>>, &'static str> {
    let Some(text) = text.filter(|text| !text.is_empty()) else {
        return Ok(None);
    };
    let mut parts = text.split('.');
    if parts.next() != Some(kind) {
        return Err(CURSOR_MALFORMED);
    }
    let rest: Vec<&str> = parts.collect();
    if rest.len() != count {
        return Err(CURSOR_MALFORMED);
    }
    Ok(Some(rest))
}

/// A whole number as the collector writes one, at least `least`: digits only.
fn whole(text: &str, least: i64) -> Result<i64, &'static str> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CURSOR_MALFORMED);
    }
    text.parse::<i64>()
        .ok()
        .filter(|number| *number >= least)
        .ok_or(CURSOR_MALFORMED)
}

/// A log list's position, `l3.<time ns>.<rowid>`: the last log's time and rowid. Logs never
/// move, and the rowid breaks ties exactly, so the next page starts right after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LogCursor {
    ns: i64,
    id: i64,
}

impl LogCursor {
    fn encode(self) -> String {
        format!("l3.{}.{}", self.ns, self.id)
    }

    fn decode(text: Option<&str>) -> Result<Option<LogCursor>, &'static str> {
        let Some(parts) = cursor_parts(text, "l3", 2)? else {
            return Ok(None);
        };
        let [ns, id] = parts.as_slice() else {
            return Err(CURSOR_MALFORMED);
        };
        Ok(Some(LogCursor {
            ns: whole(ns, 0)?,
            id: whole(id, 1)?,
        }))
    }
}

/// A trace list's position, `t3.<start ns>.<trace id>`: the last trace's start and its id, which
/// breaks ties as Motel's order does. The next page starts after it in the list as it is then: a
/// trace whose start or service changed in between can be on two pages or on none.
struct TraceCursor {
    ns: i64,
    id: [u8; 16],
}

impl TraceCursor {
    fn encode(&self) -> String {
        format!("t3.{}.{}", self.ns, hex(&self.id))
    }

    fn decode(text: Option<&str>) -> Result<Option<TraceCursor>, &'static str> {
        let Some(parts) = cursor_parts(text, "t3", 2)? else {
            return Ok(None);
        };
        let [ns, id] = parts.as_slice() else {
            return Err(CURSOR_MALFORMED);
        };
        Ok(Some(TraceCursor {
            ns: whole(ns, 0)?,
            id: exact_id::<16>(id).ok_or(CURSOR_MALFORMED)?,
        }))
    }
}

/// 400 with a message, for a request a list cannot answer.
fn refuse(out: &mut Out, message: &str) -> Result<(), Stop> {
    out.start(StatusCode::BAD_REQUEST)?;
    out.json(&json!({ "error": message }))
}

fn meta(
    limit: i64,
    lookback_minutes: i64,
    returned: usize,
    truncated: bool,
    next: Option<String>,
) -> Value {
    json!({
        "limit": limit,
        "lookback": format_lookback(lookback_minutes),
        "returned": returned,
        "truncated": truncated,
        "nextCursor": next,
    })
}

// --- Values ----------------------------------------------------------------------------------

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Nanoseconds to whole milliseconds, truncating as Motel's `BigInt` division does.
pub fn ms(ns: i64) -> i64 {
    ns / 1_000_000
}

/// A time in milliseconds as JavaScript's `Date.prototype.toISOString` writes it.
pub fn iso(ms: i64) -> String {
    let (seconds, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, of_day) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Howard Hinnant's days-to-civil conversion.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60,
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A caller's id, in the lowercase hex Motel stored and compared exactly; anything else matches
/// nothing.
fn exact_id<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.len() != N * 2
        || !text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let mut id = [0; N];
    for (index, byte) in id.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(id)
}

fn kind_name(kind: Option<i64>) -> Value {
    match kind {
        Some(1) => "internal".into(),
        Some(2) => "server".into(),
        Some(3) => "client".into(),
        Some(4) => "producer".into(),
        Some(5) => "consumer".into(),
        _ => Value::Null,
    }
}

fn is_running(start_ns: i64, end_ns: i64) -> bool {
    crate::store::running(start_ns, end_ns)
}

/// Motel's `liveDurationMs`: until now while running, else end minus start, in whole
/// milliseconds, never negative.
fn duration_ms(start_ms: i64, end_ms: i64, running: bool, now: i64) -> i64 {
    ((if running { now } else { end_ms }) - start_ms).max(0)
}

// --- Stored text, written as stored ------------------------------------------------------------
//
// A row's attributes and events are written from the text the writer stored, without decoding
// them into values: what one row holds while it is written is its own text, once, and its
// resource's. `otlp` stores attributes as one object of string values with sorted keys
// (`otlp::canonical_json`), and events as `[{name, timeNs, attributes}]`, at most
// `otlp::EVENT_LIMIT` of them.

/// One entry of a stored attribute object: its key as text, and its key and value as written.
struct Entry<'a> {
    key: Cow<'a, str>,
    raw_key: &'a str,
    raw_value: &'a str,
}

/// The entries of a stored attribute object, in order. A text not of that form has none, as a
/// text that did not decode to an object had none before (every stored row is of that form).
struct Entries<'a> {
    text: &'a str,
    at: usize,
}

impl<'a> Entries<'a> {
    fn of(text: &'a str) -> Entries<'a> {
        let mut check = Entries { text, at: 1 };
        let mut last: Option<Cow<'a, str>> = None;
        let well_formed = text.starts_with('{')
            && text.len() >= 2
            && loop {
                match check.step() {
                    Some(None) => break check.at == text.len(),
                    // Keys are in order and unique, so two objects can be merged in one pass.
                    Some(Some(entry)) if last.as_ref().is_none_or(|last| *last < entry.key) => {
                        last = Some(entry.key);
                    }
                    _ => break false,
                }
            };
        Entries {
            text,
            at: if well_formed { 1 } else { text.len() },
        }
    }

    /// The next entry; `Some(None)` at the closing brace; `None` when the text is not of the
    /// stored form.
    fn step(&mut self) -> Option<Option<Entry<'a>>> {
        let bytes = self.text.as_bytes();
        if *bytes.get(self.at)? == b'}' {
            self.at += 1;
            return Some(None);
        }
        let raw_key = self.string()?;
        if *bytes.get(self.at)? != b':' {
            return None;
        }
        self.at += 1;
        let raw_value = self.string()?;
        match *bytes.get(self.at)? {
            b',' if bytes.get(self.at + 1) == Some(&b'"') => self.at += 1,
            b'}' => {}
            _ => return None,
        }
        let key = if raw_key.contains('\\') {
            Cow::Owned(serde_json::from_str::<String>(raw_key).ok()?)
        } else {
            Cow::Borrowed(&raw_key[1..raw_key.len() - 1])
        };
        Some(Some(Entry {
            key,
            raw_key,
            raw_value,
        }))
    }

    /// A JSON string at the position, quotes included.
    fn string(&mut self) -> Option<&'a str> {
        let bytes = self.text.as_bytes();
        if *bytes.get(self.at)? != b'"' {
            return None;
        }
        let mut end = self.at + 1;
        loop {
            match *bytes.get(end)? {
                b'\\' => end += 2,
                b'"' => break,
                _ => end += 1,
            }
        }
        // A quote is never inside a multi-byte character, so both ends are boundaries.
        let found = self.text.get(self.at..=end)?;
        self.at = end + 1;
        Some(found)
    }
}

impl<'a> Iterator for Entries<'a> {
    type Item = Entry<'a>;

    fn next(&mut self) -> Option<Entry<'a>> {
        if self.at >= self.text.len() {
            return None;
        }
        self.step().flatten()
    }
}

/// A resource's attributes over a row's own, the row's winning, as Motel merged them: one object
/// with sorted keys, written as the two are read.
fn write_merged(out: &mut Out, resource: &str, own: &str) -> Result<(), Stop> {
    let (mut resource, mut own) = (Entries::of(resource), Entries::of(own));
    let (mut from_resource, mut from_own) = (resource.next(), own.next());
    out.text("{")?;
    let mut first = true;
    loop {
        let entry = match (&from_resource, &from_own) {
            (None, None) => break,
            (Some(_), None) => std::mem::replace(&mut from_resource, resource.next()),
            (Some(theirs), Some(mine)) if theirs.key < mine.key => {
                std::mem::replace(&mut from_resource, resource.next())
            }
            (Some(theirs), Some(mine)) => {
                if theirs.key == mine.key {
                    from_resource = resource.next();
                }
                std::mem::replace(&mut from_own, own.next())
            }
            (None, Some(_)) => std::mem::replace(&mut from_own, own.next()),
        };
        let Some(entry) = entry else { break };
        if !first {
            out.text(",")?;
        }
        first = false;
        out.text(entry.raw_key)?;
        out.text(":")?;
        out.text(entry.raw_value)?;
    }
    out.text("}")
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEvent<'a> {
    #[serde(borrow)]
    name: &'a serde_json::value::RawValue,
    time_ns: i64,
    #[serde(borrow)]
    attributes: &'a serde_json::value::RawValue,
}

/// A span's stored events as Motel's `{name, timestamp, attributes}`.
fn write_events(out: &mut Out, json: Option<&str>) -> Result<(), Stop> {
    let events: Vec<StoredEvent> = json
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default();
    out.text("[")?;
    for (index, event) in events.iter().enumerate() {
        if index > 0 {
            out.text(",")?;
        }
        out.text("{\"attributes\":")?;
        out.text(event.attributes.get())?;
        out.text(",\"name\":")?;
        out.text(event.name.get())?;
        out.text(",\"timestamp\":\"")?;
        out.text(&iso(ms(event.time_ns)))?;
        out.text("\"}")?;
    }
    out.text("]")
}

// --- The trace being evicted -----------------------------------------------------------------

/// The rowid and id of the trace being evicted, read in the query's own snapshot.
fn evicting(connection: &Connection) -> rusqlite::Result<Option<(i64, Vec<u8>)>> {
    let Some(trace) = crate::retention::evicting(connection)? else {
        return Ok(None);
    };
    connection
        .prepare_cached("SELECT trace_id FROM traces WHERE id = ?1")?
        .query_row([trace], |row| row.get(0))
        .optional()
        .map(|id| id.map(|id| (trace, id)))
}

/// SQL with its parameters, built clause by clause.
struct Sql {
    clauses: Vec<String>,
    values: Vec<SqlValue>,
}

impl Sql {
    fn new() -> Sql {
        Sql {
            clauses: Vec::new(),
            values: Vec::new(),
        }
    }

    /// Add a clause; `?` in it stands for the next values, in order.
    fn and(&mut self, clause: &str, values: impl IntoIterator<Item = SqlValue>) {
        let mut text = String::new();
        for (index, part) in clause.split('?').enumerate() {
            if index > 0 {
                text.push_str(&format!("?{}", self.values.len() + 1));
                self.values.push(SqlValue::Null);
            }
            text.push_str(part);
        }
        let start = self.values.len() - clause.matches('?').count();
        for (slot, value) in self.values[start..].iter_mut().zip(values) {
            *slot = value;
        }
        self.clauses.push(text);
    }

    fn filter(&self) -> String {
        if self.clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", self.clauses.join(" AND "))
        }
    }
}

/// A JSON path for one attribute key, quoted so a key with dots names one member.
fn json_path(key: &str) -> String {
    let mut path = String::from("$.\"");
    for character in key.chars() {
        if character == '"' || character == '\\' {
            path.push('\\');
        }
        path.push(character);
    }
    path.push('"');
    path
}

/// `attr.<key>=<value>` clauses over a row's own attributes, then its resource's.
fn attribute_clauses(sql: &mut Sql, filters: &[(String, String)], own: &str, resource: &str) {
    for (key, value) in filters {
        let path = json_path(key);
        sql.and(
            &format!("coalesce(json_extract({own}, ?), json_extract({resource}, ?)) = ?"),
            [
                SqlValue::Text(path.clone()),
                SqlValue::Text(path),
                SqlValue::Text(value.clone()),
            ],
        );
    }
}

// --- Routes ----------------------------------------------------------------------------------

/// `GET /api/services`: services with spans or logs in the last day, by name.
pub fn services(connection: &Connection, out: &mut Out) -> Result<(), Stop> {
    let cutoff_ns = (now_ms() - SERVICES_LOOKBACK_MINUTES * 60_000) * 1_000_000;
    // The trace being evicted counts for nothing, its spans or its logs.
    let (trace, trace_id) = match evicting(connection)? {
        Some((trace, trace_id)) => (Some(trace), Some(trace_id)),
        None => (None, None),
    };
    let mut statement = connection.prepare_cached(
        "SELECT DISTINCT service_name FROM resources AS r
         WHERE EXISTS (SELECT 1 FROM spans WHERE resource = r.id AND start_ns >= ?1 AND (?2 IS NULL OR trace != ?2))
            OR EXISTS (SELECT 1 FROM logs WHERE resource = r.id AND time_ns >= ?1 AND (?3 IS NULL OR trace_id IS NOT ?3))
         ORDER BY service_name",
    )?;
    let mut rows = statement.query(rusqlite::params![cutoff_ns, trace, trace_id])?;
    out.start(StatusCode::OK)?;
    out.text("{\"data\":[")?;
    let mut first = true;
    while let Some(row) = rows.next()? {
        if !first {
            out.text(",")?;
        }
        first = false;
        out.json(&row.get::<_, String>(0)?)?;
    }
    out.text("]}")
}

/// `GET /api/traces`: trace summaries newest first. A later page continues after its cursor in
/// the list as it is when the page is asked for.
pub fn traces(connection: &Connection, out: &mut Out, query: &Query) -> Result<(), Stop> {
    let limit = query.limit(TRACE_LIST);
    let lookback = query.lookback_minutes();
    let now = now_ms();
    let cursor = match TraceCursor::decode(query.get("cursor")) {
        Ok(cursor) => cursor,
        Err(message) => return refuse(out, message),
    };
    let mut sql = Sql::new();
    sql.and(
        "started_ns >= ?",
        [SqlValue::Integer((now - lookback * 60_000) * 1_000_000)],
    );
    if let Some(service) = query.filter("service") {
        sql.and(
            "service = (SELECT id FROM services WHERE name = ?)",
            [SqlValue::Text(service.to_owned())],
        );
    }
    if let Some(cursor) = &cursor {
        sql.and(
            // A row value, so SQLite continues along the index instead of sorting what is left.
            "(started_ns, trace_id) < (?, ?)",
            [
                SqlValue::Integer(cursor.ns),
                SqlValue::Blob(cursor.id.to_vec()),
            ],
        );
    }
    if let Some((trace, _)) = evicting(connection)? {
        sql.and("id != ?", [SqlValue::Integer(trace)]);
    }
    let text = format!(
        "SELECT trace_id, coalesce((SELECT name FROM services WHERE id = traces.service), ''), root_name,
                started_ns, ended_ns, span_count, error_count, running_count
         FROM traces {} ORDER BY started_ns DESC, trace_id DESC LIMIT {}",
        sql.filter(),
        limit + 1
    );
    let mut statement = connection.prepare(&text)?;
    let mut rows = statement.query(params_from_iter(sql.values.iter()))?;
    out.start(StatusCode::OK)?;
    out.text("{\"data\":[")?;
    let (mut returned, mut truncated, mut last) = (0usize, false, None);
    while let Some(row) = rows.next()? {
        if returned as i64 == limit {
            truncated = true;
            break;
        }
        if returned > 0 {
            out.text(",")?;
        }
        let trace_id: Vec<u8> = row.get(0)?;
        let started_ns: i64 = row.get(3)?;
        let running = row.get::<_, i64>(7)? > 0;
        let start = ms(started_ns);
        out.json(&json!({
            "traceId": hex(&trace_id),
            "serviceName": row.get::<_, String>(1)?,
            "rootOperationName": row.get::<_, Option<String>>(2)?.unwrap_or_else(|| "unknown".to_owned()),
            "startedAt": iso(start),
            "isRunning": running,
            "durationMs": duration_ms(start, ms(row.get(4)?), running, now),
            "spanCount": row.get::<_, i64>(5)?,
            "errorCount": row.get::<_, i64>(6)?,
            "warnings": [],
        }))?;
        returned += 1;
        last = Some(TraceCursor {
            ns: started_ns,
            id: id16(&trace_id),
        });
    }
    out.text("],\"meta\":")?;
    out.json(&meta(
        limit,
        lookback,
        returned,
        truncated,
        last.map(|cursor| cursor.encode()),
    ))?;
    out.text("}")
}

/// `GET /api/traces/stats?groupBy=service|operation|status&agg=count`.
pub fn trace_stats(connection: &Connection, out: &mut Out, query: &Query) -> Result<(), Stop> {
    let (group_by, agg) = (query.filter("groupBy"), query.get("agg"));
    let Some(group_by) = group_by.filter(|_| agg == Some("count")) else {
        // Motel's other aggregations are not kept.
        let dropped = matches!(agg, Some("avg_duration" | "p95_duration" | "error_rate"));
        out.start(StatusCode::BAD_REQUEST)?;
        return out.json(&json!({
            "error": if dropped && group_by.is_some() {
                "Only agg=count is supported"
            } else {
                "Expected groupBy and agg=count|avg_duration|p95_duration|error_rate"
            }
        }));
    };
    // Any other grouping puts every trace in one group, as Motel's did.
    let group = match group_by {
        "service" => "coalesce((SELECT name FROM services WHERE id = traces.service), '')",
        "operation" => "coalesce(root_name, 'unknown')",
        "status" => "CASE WHEN error_count > 0 THEN 'error' ELSE 'ok' END",
        _ => "'unknown'",
    };
    let limit = query.limit(TRACE_STATS);
    let lookback = query.lookback_minutes();
    let mut sql = Sql::new();
    sql.and(
        "started_ns >= ?",
        [SqlValue::Integer(
            (now_ms() - lookback * 60_000) * 1_000_000,
        )],
    );
    if let Some(service) = query.filter("service") {
        sql.and(
            "service = (SELECT id FROM services WHERE name = ?)",
            [SqlValue::Text(service.to_owned())],
        );
    }
    if let Some((trace, _)) = evicting(connection)? {
        sql.and("id != ?", [SqlValue::Integer(trace)]);
    }
    let text = format!(
        "SELECT {group} AS grp, count(*) AS value FROM traces {} GROUP BY grp ORDER BY value DESC, grp LIMIT {limit}",
        sql.filter()
    );
    let mut statement = connection.prepare(&text)?;
    let mut rows = statement.query(params_from_iter(sql.values.iter()))?;
    out.start(StatusCode::OK)?;
    out.text("{\"data\":[")?;
    let mut first = true;
    while let Some(row) = rows.next()? {
        if !first {
            out.text(",")?;
        }
        first = false;
        let count: i64 = row.get(1)?;
        out.json(&json!({ "group": row.get::<_, String>(0)?, "value": count, "count": count }))?;
    }
    out.text("]}")
}

/// Rows, or nodes of a trace's tree, between checks of a query's deadline, the read gate and its
/// caller, in the loops SQLite's progress handler cannot reach.
const CHECK_ROWS: usize = 4096;

/// One span of a trace's skeleton: what ordering it needs. With its map entries, at most
/// `REAL_NODE_BYTES`; about 100 bytes in an ordinary tree.
struct Node {
    rowid: i64,
    span_id: [u8; 8],
    parent: Option<[u8; 8]>,
    /// In nanoseconds, so a trace cut short keeps the spans that start first, exactly. A
    /// synthetic parent's is its earliest child's.
    start_ns: i64,
    duration_ms: i64,
    running: bool,
    error: bool,
    /// For a synthetic parent: its children, for its service name.
    synthetic: Option<Synthetic>,
}

struct Synthetic {
    first_child: usize,
    children: usize,
}

/// A trace in Motel's order (`buildTrace`): spans depth first, siblings by start time, a
/// synthetic span for each missing parent.
struct TraceTree {
    nodes: Vec<Node>,
    /// Indexes into `nodes`, in order, with depth.
    order: Vec<(usize, i64)>,
    index: HashMap<[u8; 8], usize>,
    synthetic_warnings: Vec<String>,
    /// The trace's spans, all of them; more than the tree holds when it was cut (`SKELETON_BYTES`).
    total: i64,
}

/// The most working memory one trace's skeleton may take, whatever the trace holds. A trace whose
/// skeleton would take more is answered with the spans that start first, as many as fit, and the
/// answer says so; a trace under it is answered whole. 48 MiB holds a tree of about 190,000 spans,
/// or about 75,000 when every span's parent is missing.
pub const SKELETON_BYTES: usize = 48 << 20;
/// Upper bounds on what one span takes in the skeleton: its node, its index entry, its place in
/// the order and among its parent's children (`REAL_NODE_BYTES`); and what a synthetic parent for
/// a missing span takes besides (`SYNTHETIC_NODE_BYTES`): its node and entries, its warning and
/// its list of children. Names are not kept, so neither depends on the data.
const REAL_NODE_BYTES: usize = 256;
const SYNTHETIC_NODE_BYTES: usize = 384;

impl TraceTree {
    /// The trace's warnings: first one when the tree holds only the trace's first spans, then a
    /// synthetic span's for each missing parent.
    fn warnings(&self) -> impl Iterator<Item = Cow<'_, str>> {
        // The cut first: it is about the whole answer.
        let cut = self.cut().then(|| {
            Cow::Owned(format!(
                "the trace has {} spans; this answer holds the first {} by start time, as many as one answer may hold",
                self.total,
                self.kept()
            ))
        });
        cut.into_iter().chain(
            self.synthetic_warnings
                .iter()
                .map(|warning| Cow::Borrowed(warning.as_str())),
        )
    }

    /// Whether the tree holds only the first part of the trace.
    fn cut(&self) -> bool {
        (self.kept() as i64) < self.total
    }

    /// The stored spans the tree holds: the trace's first by start time when it is cut. Synthetic
    /// parents are not counted.
    fn kept(&self) -> usize {
        self.nodes
            .iter()
            .filter(|node| node.synthetic.is_none())
            .count()
    }

    /// For a trace cut short, `{spanCount, returned}`: its stored spans, and how many of them
    /// the answer holds. The answer's list holds a synthetic parent for each missing parent
    /// besides, so it can be longer than `returned`.
    fn partial(&self) -> Option<Value> {
        self.cut().then(|| {
            json!({
                "spanCount": self.total,
                "returned": self.kept(),
            })
        })
    }

    fn read(connection: &Connection, trace: i64, out: &Out, now: i64) -> Result<TraceTree, Stop> {
        let total: i64 = connection
            .prepare_cached("SELECT count(*) FROM spans WHERE trace = ?1")?
            .query_row([trace], |row| row.get(0))?;
        let most = SKELETON_BYTES / REAL_NODE_BYTES;
        // A trace too large to hold whole is read by start time, its first spans first.
        let mut statement = if total as usize <= most {
            connection.prepare_cached(
                "SELECT id, span_id, parent_span_id, start_ns, end_ns, status FROM spans WHERE trace = ?1 AND ?2 >= 0",
            )?
        } else {
            connection.prepare_cached(
                "SELECT id, span_id, parent_span_id, start_ns, end_ns, status FROM spans WHERE trace = ?1
                 ORDER BY start_ns, id LIMIT ?2",
            )?
        };
        let mut rows = statement.query(rusqlite::params![trace, most as i64])?;
        let mut nodes = Vec::with_capacity((total as usize).min(most));
        while let Some(row) = rows.next()? {
            if nodes.len() % CHECK_ROWS == 0 {
                out.check()?;
            }
            let (start, end): (i64, i64) = (row.get(3)?, row.get(4)?);
            let running = is_running(start, end);
            nodes.push(Node {
                rowid: row.get(0)?,
                span_id: id8(&row.get::<_, Vec<u8>>(1)?),
                parent: row.get::<_, Option<Vec<u8>>>(2)?.map(|parent| id8(&parent)),
                start_ns: start,
                duration_ms: duration_ms(ms(start), ms(end), running, now),
                running,
                error: row.get::<_, i64>(5)? != 0,
                synthetic: None,
            });
        }
        drop(rows);
        // Motel read spans by start time, in milliseconds; storage order breaks ties.
        let motel_order = |node: &Node| (ms(node.start_ns), node.rowid);
        nodes.sort_by_key(motel_order);
        let mut index: HashMap<[u8; 8], usize> = HashMap::with_capacity(nodes.len());
        index.extend(
            nodes
                .iter()
                .enumerate()
                .map(|(position, node)| (node.span_id, position)),
        );
        // Synthetic parents cost more; when they would take the skeleton past its budget, keep the
        // spans that start first, as many as fit even if every one's parent were missing.
        let missing: std::collections::HashSet<[u8; 8]> = nodes
            .iter()
            .filter_map(|node| node.parent.filter(|parent| !index.contains_key(parent)))
            .collect();
        if nodes.len() * REAL_NODE_BYTES + missing.len() * SYNTHETIC_NODE_BYTES > SKELETON_BYTES {
            drop(missing);
            // The first by start time in nanoseconds, then storage order: the rule the query
            // above keeps a trace too large to read whole by, so both cuts keep the same spans.
            let keep = SKELETON_BYTES / (REAL_NODE_BYTES + SYNTHETIC_NODE_BYTES);
            nodes.sort_by_key(|node| (node.start_ns, node.rowid));
            nodes.truncate(keep);
            nodes.sort_by_key(motel_order);
            nodes.shrink_to_fit();
            index = HashMap::with_capacity(nodes.len());
            index.extend(
                nodes
                    .iter()
                    .enumerate()
                    .map(|(position, node)| (node.span_id, position)),
            );
        }
        // A synthetic parent for each missing parent, in the order its first child was read.
        let mut missing: Vec<([u8; 8], Vec<usize>)> = Vec::new();
        let mut missing_at: HashMap<[u8; 8], usize> = HashMap::new();
        for (position, node) in nodes.iter().enumerate() {
            if position % CHECK_ROWS == 0 {
                out.check()?;
            }
            if let Some(parent) = node.parent
                && !index.contains_key(&parent)
            {
                let slot = *missing_at.entry(parent).or_insert_with(|| {
                    missing.push((parent, Vec::new()));
                    missing.len() - 1
                });
                missing[slot].1.push(position);
            }
        }
        let mut synthetic_warnings = Vec::new();
        for (parent, children) in missing {
            let start = children
                .iter()
                .map(|child| nodes[*child].start_ns)
                .min()
                .unwrap_or(0);
            let end = children
                .iter()
                .map(|child| ms(nodes[*child].start_ns) + nodes[*child].duration_ms)
                .max()
                .unwrap_or(ms(start));
            let count = children.len();
            synthetic_warnings.push(format!(
                "missing span {} ({count} child{})",
                hex(&parent),
                if count == 1 { "" } else { "ren" }
            ));
            index.insert(parent, nodes.len());
            nodes.push(Node {
                rowid: 0,
                span_id: parent,
                parent: None,
                start_ns: start,
                duration_ms: (end - ms(start)).max(0),
                running: children.iter().any(|child| nodes[*child].running),
                error: true,
                synthetic: Some(Synthetic {
                    first_child: children[0],
                    children: count,
                }),
            });
        }
        // Children by parent, in reading order, then sorted by start time, synthetic last; the
        // sort is stable, as JavaScript's is.
        let mut roots = Vec::new();
        let mut children: HashMap<usize, Vec<usize>> = HashMap::new();
        for (position, node) in nodes.iter().enumerate() {
            if position % CHECK_ROWS == 0 {
                out.check()?;
            }
            match node.parent.and_then(|parent| index.get(&parent).copied()) {
                Some(parent) => children.entry(parent).or_default().push(position),
                None => roots.push(position),
            }
        }
        let key = |position: &usize| {
            (
                ms(nodes[*position].start_ns),
                nodes[*position].synthetic.is_some(),
            )
        };
        roots.sort_by_key(key);
        for siblings in children.values_mut() {
            siblings.sort_by_key(key);
        }
        // Depth first from the roots, without recursion: a chain can be any length. A span in a
        // cycle of parents is never reached, as in Motel.
        let mut order = Vec::with_capacity(nodes.len());
        let mut stack: Vec<(usize, i64)> = roots.iter().rev().map(|root| (*root, 0)).collect();
        while let Some((position, depth)) = stack.pop() {
            if order.len() % CHECK_ROWS == 0 {
                out.check()?;
            }
            order.push((position, depth));
            if let Some(siblings) = children.get(&position) {
                stack.extend(siblings.iter().rev().map(|child| (*child, depth + 1)));
            }
        }
        Ok(TraceTree {
            nodes,
            order,
            index,
            synthetic_warnings,
            total,
        })
    }

    /// The trace's root: the first real span without a parent, else the first real span.
    fn root(&self) -> Option<usize> {
        let real = |(position, _): &&(usize, i64)| self.nodes[*position].synthetic.is_none();
        self.order
            .iter()
            .filter(real)
            .find(|(position, _)| self.nodes[*position].parent.is_none())
            .or_else(|| self.order.iter().find(real))
            .or_else(|| self.order.first())
            .map(|(position, _)| *position)
    }
}

/// A stored id as a fixed array: its first 16 bytes, zero-filled if the stored value is shorter.
fn id16(bytes: &[u8]) -> [u8; 16] {
    let mut id = [0; 16];
    for (slot, byte) in id.iter_mut().zip(bytes) {
        *slot = *byte;
    }
    id
}

/// A stored id as a fixed array: its first 8 bytes, zero-filled if the stored value is shorter.
fn id8(bytes: &[u8]) -> [u8; 8] {
    let mut id = [0; 8];
    for (slot, byte) in id.iter_mut().zip(bytes) {
        *slot = *byte;
    }
    id
}

/// A span's name and service, by rowid.
fn name_and_service(connection: &Connection, rowid: i64) -> rusqlite::Result<(String, String)> {
    connection
        .prepare_cached(
            "SELECT spans.name, resources.service_name FROM spans JOIN resources ON resources.id = spans.resource WHERE spans.id = ?1",
        )?
        .query_row([rowid], |row| Ok((row.get(0)?, row.get(1)?)))
}

/// Resources' service names and stored attributes for one answer. Kept while their text totals
/// at most `RESOURCE_CACHE_BYTES`; a resource read after that is kept only while the rows that
/// need it follow one another, so an answer over many large resources holds one at a time.
struct Resources {
    kept: HashMap<i64, Rc<Resource>>,
    kept_bytes: usize,
    last: Option<(i64, Rc<Resource>)>,
}

/// A resource's service name and its attributes as stored.
type Resource = (String, String);

/// The most resource text one answer keeps, besides the resource of the current row.
pub const RESOURCE_CACHE_BYTES: usize = 256 * 1024;

impl Resources {
    fn new() -> Resources {
        Resources {
            kept: HashMap::new(),
            kept_bytes: 0,
            last: None,
        }
    }

    fn get(&mut self, connection: &Connection, id: i64) -> rusqlite::Result<Rc<Resource>> {
        if let Some(found) = self.kept.get(&id) {
            return Ok(found.clone());
        }
        if let Some((last, found)) = &self.last
            && *last == id
        {
            return Ok(found.clone());
        }
        let (service, attributes): (String, String) = connection
            .prepare_cached("SELECT service_name, attributes_json FROM resources WHERE id = ?1")?
            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let length = service.len() + attributes.len();
        let found = Rc::new((service, attributes));
        if self.kept_bytes + length <= RESOURCE_CACHE_BYTES {
            self.kept_bytes += length;
            self.kept.insert(id, found.clone());
        } else {
            self.last = Some((id, found.clone()));
        }
        Ok(found)
    }
}

/// One stored span, as read for an answer.
struct SpanRecord {
    span_id: Vec<u8>,
    parent: Option<Vec<u8>>,
    resource: i64,
    scope: Option<String>,
    name: String,
    kind: Option<i64>,
    start: i64,
    end: i64,
    status: i64,
    attributes: String,
    events: Option<String>,
    events_dropped: i64,
}

impl SpanRecord {
    fn read(connection: &Connection, rowid: i64) -> rusqlite::Result<SpanRecord> {
        connection
            .prepare_cached(
                "SELECT span_id, parent_span_id, resource, scope_name, name, kind, start_ns, end_ns, status, attributes_json, events_json, events_dropped
                 FROM spans WHERE id = ?1",
            )?
            .query_row([rowid], |row| {
                Ok(SpanRecord {
                    span_id: row.get(0)?,
                    parent: row.get(1)?,
                    resource: row.get(2)?,
                    scope: row.get(3)?,
                    name: row.get(4)?,
                    kind: row.get(5)?,
                    start: row.get(6)?,
                    end: row.get(7)?,
                    status: row.get(8)?,
                    attributes: row.get(9)?,
                    events: row.get(10)?,
                    events_dropped: row.get(11)?,
                })
            })
    }

    /// Write it as Motel's `TraceSpanItem`, its keys in the order a JSON value of it would have,
    /// with `warnings` before the one for events the span did not keep.
    fn write(
        &self,
        connection: &Connection,
        out: &mut Out,
        resources: &mut Resources,
        depth: i64,
        warnings: &[String],
        now: i64,
    ) -> Result<(), Stop> {
        let resource = resources.get(connection, self.resource)?;
        let (service, resource_attributes) = &*resource;
        let running = is_running(self.start, self.end);
        out.text("{\"depth\":")?;
        out.json(&depth)?;
        out.text(",\"durationMs\":")?;
        out.json(&duration_ms(ms(self.start), ms(self.end), running, now))?;
        out.text(",\"events\":")?;
        write_events(out, self.events.as_deref())?;
        out.text(",\"isRunning\":")?;
        out.json(&running)?;
        out.text(",\"kind\":")?;
        out.json(&kind_name(self.kind))?;
        out.text(",\"operationName\":")?;
        out.json(&self.name)?;
        out.text(",\"parentSpanId\":")?;
        out.json(&self.parent.as_deref().map(hex))?;
        out.text(",\"scopeName\":")?;
        out.json(&self.scope)?;
        out.text(",\"serviceName\":")?;
        out.json(service)?;
        out.text(",\"spanId\":")?;
        out.json(&hex(&self.span_id))?;
        out.text(",\"startTime\":")?;
        out.json(&iso(ms(self.start)))?;
        out.text(",\"status\":")?;
        out.json(if self.status != 0 { "error" } else { "ok" })?;
        out.text(",\"tags\":")?;
        write_merged(out, resource_attributes, &self.attributes)?;
        out.text(",\"warnings\":[")?;
        for (index, warning) in warnings.iter().enumerate() {
            if index > 0 {
                out.text(",")?;
            }
            out.json(warning)?;
        }
        if self.events_dropped > 0 {
            if !warnings.is_empty() {
                out.text(",")?;
            }
            out.json(&format!(
                "{} events dropped: a span keeps its first {}",
                self.events_dropped,
                crate::otlp::EVENT_LIMIT
            ))?;
        }
        out.text("]}")
    }
}

/// A synthetic parent as Motel's `TraceSpanItem`.
fn synthetic_json(
    connection: &Connection,
    tree: &TraceTree,
    position: usize,
) -> Result<Value, Stop> {
    let node = &tree.nodes[position];
    let synthetic = node.synthetic.as_ref().expect("a synthetic span");
    let (_, service) = name_and_service(connection, tree.nodes[synthetic.first_child].rowid)?;
    let id = hex(&node.span_id);
    Ok(json!({
        "spanId": id,
        "parentSpanId": null,
        "serviceName": service,
        "scopeName": null,
        "kind": null,
        "operationName": format!("[missing parent {}]", &id[..8]),
        "startTime": iso(ms(node.start_ns)),
        "isRunning": node.running,
        "durationMs": node.duration_ms,
        "status": "error",
        "depth": 0,
        "tags": {},
        "warnings": [format!("missing span {id} ({} child{})", synthetic.children, if synthetic.children == 1 { "" } else { "ren" })],
        "events": [],
    }))
}

/// The rowid of a trace by its id, unless it is being evicted.
fn trace_rowid(connection: &Connection, trace_id: &str) -> Result<Option<i64>, Stop> {
    let Some(id) = exact_id::<16>(trace_id) else {
        return Ok(None);
    };
    let found: Option<i64> = connection
        .prepare_cached("SELECT id FROM traces WHERE trace_id = ?1")?
        .query_row([id.as_slice()], |row| row.get(0))
        .optional()?;
    let evicting = crate::retention::evicting(connection)?;
    Ok(found.filter(|found| Some(*found) != evicting))
}

/// What the whole trace shows: its root's name and service, start, duration and counts.
struct Header {
    root_name: String,
    service: String,
    started_ms: i64,
    duration_ms: i64,
    running: bool,
    errors: usize,
}

fn header(connection: &Connection, tree: &TraceTree) -> Result<Header, Stop> {
    let (root_name, service) = match tree.root() {
        Some(position) if tree.nodes[position].synthetic.is_none() => {
            name_and_service(connection, tree.nodes[position].rowid)?
        }
        Some(position) => {
            let synthetic = synthetic_json(connection, tree, position)?;
            (
                synthetic["operationName"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_owned(),
                synthetic["serviceName"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_owned(),
            )
        }
        None => ("unknown".to_owned(), "unknown".to_owned()),
    };
    let ordered = tree
        .order
        .iter()
        .map(|(position, _)| &tree.nodes[*position]);
    let started_ms = ordered
        .clone()
        .map(|node| ms(node.start_ns))
        .min()
        .unwrap_or(0);
    let ended_ms = ordered
        .clone()
        .map(|node| ms(node.start_ns) + node.duration_ms)
        .max()
        .unwrap_or(started_ms);
    Ok(Header {
        root_name,
        service,
        started_ms,
        duration_ms: (ended_ms - started_ms).max(0),
        running: ordered.clone().any(|node| node.running),
        errors: ordered.filter(|node| node.error).count(),
    })
}

/// `GET /api/traces/:traceId`: the whole trace, its spans in tree order; 404 when it is not
/// stored or is being evicted.
pub fn trace(connection: &Connection, out: &mut Out, trace_id: &str) -> Result<(), Stop> {
    let Some(trace) = trace_rowid(connection, trace_id)? else {
        out.start(StatusCode::NOT_FOUND)?;
        return out.json(&json!({ "error": "Trace not found" }));
    };
    let now = now_ms();
    let tree = TraceTree::read(connection, trace, out, now)?;
    let header = header(connection, &tree)?;
    out.start(StatusCode::OK)?;
    out.text("{\"data\":")?;
    // Written field by field in the order a JSON value of it would have (sorted keys), so no
    // part of the answer is built whole: the warnings can be as many as the missing parents.
    out.text("{\"durationMs\":")?;
    out.json(&header.duration_ms)?;
    out.text(",\"errorCount\":")?;
    out.json(&header.errors)?;
    out.text(",\"isRunning\":")?;
    out.json(&header.running)?;
    // Only on a trace cut short (`SKELETON_BYTES`), so an answer under it is Motel's.
    if let Some(partial) = tree.partial() {
        out.text(",\"partial\":")?;
        out.json(&partial)?;
    }
    out.text(",\"rootOperationName\":")?;
    out.json(&header.root_name)?;
    out.text(",\"serviceName\":")?;
    out.json(&header.service)?;
    out.text(",\"spanCount\":")?;
    out.json(&tree.order.len())?;
    out.text(",\"startedAt\":")?;
    out.json(&iso(header.started_ms))?;
    out.text(",\"traceId\":")?;
    out.json(trace_id)?;
    out.text(",\"warnings\":[")?;
    for (index, warning) in tree.warnings().enumerate() {
        if index > 0 {
            out.text(",")?;
        }
        out.json(&*warning)?;
    }
    out.text("]")?;
    out.text(",\"spans\":[")?;
    let mut resources = Resources::new();
    for (number, (position, depth)) in tree.order.iter().enumerate() {
        if number > 0 {
            out.text(",")?;
        }
        out.check()?;
        let node = &tree.nodes[*position];
        if node.synthetic.is_some() {
            out.json(&synthetic_json(connection, &tree, *position)?)?;
        } else {
            SpanRecord::read(connection, node.rowid)?.write(
                connection,
                out,
                &mut resources,
                *depth,
                &[],
                now,
            )?;
        }
    }
    out.text("]}}")
}

/// `GET /api/traces/:traceId/spans`: the trace's spans in tree order, each with its trace's root
/// and its parent's name; an empty list when the trace is not stored.
pub fn trace_spans(connection: &Connection, out: &mut Out, trace_id: &str) -> Result<(), Stop> {
    let Some(trace) = trace_rowid(connection, trace_id)? else {
        out.start(StatusCode::OK)?;
        return out.text("{\"data\":[]}");
    };
    let now = now_ms();
    let tree = TraceTree::read(connection, trace, out, now)?;
    let header = header(connection, &tree)?;
    out.start(StatusCode::OK)?;
    out.text("{\"data\":[")?;
    let mut resources = Resources::new();
    for (number, (position, depth)) in tree.order.iter().enumerate() {
        if number > 0 {
            out.text(",")?;
        }
        out.check()?;
        let node = &tree.nodes[*position];
        let parent_name = match node
            .parent
            .and_then(|parent| tree.index.get(&parent).copied())
        {
            Some(parent) if tree.nodes[parent].synthetic.is_some() => Some(format!(
                "[missing parent {}]",
                &hex(&tree.nodes[parent].span_id)[..8]
            )),
            // Looked up for each child: a name can be as large as an export, so none is kept.
            Some(parent) => Some(name_and_service(connection, tree.nodes[parent].rowid)?.0),
            None => None,
        };
        // Keys in the order a JSON value of the item would have.
        out.text("{\"parentOperationName\":")?;
        out.json(&parent_name)?;
        out.text(",\"rootOperationName\":")?;
        out.json(&header.root_name)?;
        out.text(",\"span\":")?;
        if node.synthetic.is_some() {
            out.json(&synthetic_json(connection, &tree, *position)?)?;
        } else {
            SpanRecord::read(connection, node.rowid)?.write(
                connection,
                out,
                &mut resources,
                *depth,
                &[],
                now,
            )?;
        }
        out.text(",\"traceId\":")?;
        out.json(&trace_id)?;
        out.text("}")?;
    }
    if tree.cut() {
        // The answer is the first part of the trace: say so after the list (`SKELETON_BYTES`).
        out.text("],\"meta\":")?;
        out.json(&json!({
            "truncated": true,
            "returned": tree.kept(),
            "spanCount": tree.total,
        }))?;
        return out.text("}");
    }
    out.text("]}")
}

/// `GET /api/spans/search`: spans newest first, by service, trace, operation and attributes.
pub fn search_spans(connection: &Connection, out: &mut Out, query: &Query) -> Result<(), Stop> {
    let limit = query.limit(SPAN_LIST);
    let lookback = query.lookback_minutes();
    let now = now_ms();
    let mut sql = Sql::new();
    sql.and(
        "s.start_ns >= ?",
        [SqlValue::Integer((now - lookback * 60_000) * 1_000_000)],
    );
    if let Some(trace_id) = query.filter("traceId") {
        match exact_id::<16>(trace_id) {
            Some(id) => sql.and(
                "s.trace = (SELECT id FROM traces WHERE trace_id = ?)",
                [SqlValue::Blob(id.to_vec())],
            ),
            None => sql.and("0", []),
        }
    }
    if let Some(service) = query.filter("service") {
        sql.and("r.service_name = ?", [SqlValue::Text(service.to_owned())]);
    }
    attribute_clauses(
        &mut sql,
        &query.attributes(),
        "s.attributes_json",
        "r.attributes_json",
    );
    if let Some((trace, _)) = evicting(connection)? {
        sql.and("s.trace != ?", [SqlValue::Integer(trace)]);
    }
    let operation = query.filter("operation").map(TextMatch::new);
    let text = format!(
        "SELECT s.id, s.trace, s.name, s.parent_span_id FROM spans AS s JOIN resources AS r ON r.id = s.resource
         {} ORDER BY s.start_ns DESC, s.id DESC",
        sql.filter()
    );
    let mut statement = connection.prepare(&text)?;
    let mut rows = statement.query(params_from_iter(sql.values.iter()))?;
    // The matching spans: rowid, trace and parent, at most limit + 1.
    let mut found: Vec<(i64, i64, Option<[u8; 8]>)> = Vec::new();
    let mut scanned = 0u64;
    while let Some(row) = rows.next()? {
        scanned += 1;
        if scanned.is_multiple_of(CHECK_ROWS as u64) {
            out.check()?;
        }
        if let Some(operation) = &operation
            && !operation.matches(
                row.get_ref(2)?.as_str().map_err(rusqlite::Error::from)?,
                out,
            )?
        {
            continue;
        }
        found.push((
            row.get(0)?,
            row.get(1)?,
            row.get::<_, Option<Vec<u8>>>(3)?.map(|parent| id8(&parent)),
        ));
        if found.len() as i64 > limit {
            break;
        }
    }
    drop(rows);
    let truncated = found.len() as i64 > limit;
    found.truncate(limit as usize);
    out.start(StatusCode::OK)?;
    out.text("{\"data\":[")?;
    let mut resources = Resources::new();
    let mut depths: HashMap<(i64, [u8; 8]), i64> = HashMap::new();
    for (number, (rowid, trace, parent)) in found.iter().enumerate() {
        if number > 0 {
            out.text(",")?;
        }
        out.check()?;
        let (trace_id, root_name, root_started): (Vec<u8>, Option<String>, Option<i64>) =
            connection
                .prepare_cached(
                    "SELECT trace_id, root_name, root_started_ns FROM traces WHERE id = ?1",
                )?
                .query_row([trace], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        let parent_name: Option<String> = match parent {
            Some(parent) => connection
                .prepare_cached("SELECT name FROM spans WHERE trace = ?1 AND span_id = ?2")?
                .query_row(rusqlite::params![trace, parent.as_slice()], |row| {
                    row.get(0)
                })
                .optional()?,
            None => None,
        };
        let warnings = match (parent, &parent_name) {
            (Some(parent), None) => vec![format!("missing span {} (1 child)", hex(parent))],
            _ => Vec::new(),
        };
        let depth = depth(connection, *trace, *parent, &mut depths, out)?;
        let span = SpanRecord::read(connection, *rowid)?;
        // The earliest root's name, else the span's own, as Motel's search chose.
        let root = match (root_started, root_name) {
            (Some(_), Some(name)) => Cow::Owned(name),
            _ => Cow::Borrowed(span.name.as_str()),
        };
        // Keys in the order a JSON value of the item would have.
        out.text("{\"parentOperationName\":")?;
        out.json(&parent_name)?;
        out.text(",\"rootOperationName\":")?;
        out.json(&root)?;
        out.text(",\"span\":")?;
        span.write(connection, out, &mut resources, depth, &warnings, now)?;
        out.text(",\"traceId\":")?;
        out.json(&hex(&trace_id))?;
        out.text("}")?;
    }
    out.text("],\"meta\":")?;
    out.json(&meta(limit, lookback, found.len(), truncated, None))?;
    out.text("}")
}

/// A span's depth: how many parents it has in its trace, a missing parent counting as one with
/// none. A cycle of parents ends the walk, as in Motel.
fn depth(
    connection: &Connection,
    trace: i64,
    parent: Option<[u8; 8]>,
    known: &mut HashMap<(i64, [u8; 8]), i64>,
    out: &Out,
) -> Result<i64, Stop> {
    let mut chain: Vec<[u8; 8]> = Vec::new();
    let mut next = parent;
    let mut base = 0;
    while let Some(id) = next {
        if let Some(depth) = known.get(&(trace, id)) {
            base = *depth + 1;
            break;
        }
        if chain.contains(&id) {
            break;
        }
        if chain.len() % 4096 == 4095 {
            out.check()?;
        }
        chain.push(id);
        next = connection
            .prepare_cached("SELECT parent_span_id FROM spans WHERE trace = ?1 AND span_id = ?2")?
            .query_row(rusqlite::params![trace, id.as_slice()], |row| {
                row.get::<_, Option<Vec<u8>>>(0)
            })
            .optional()?
            .flatten()
            .map(|parent| id8(&parent));
    }
    // Depths from the farthest ancestor found back to the parent.
    let mut depth = base;
    for id in chain.iter().rev() {
        if known.len() < 65_536 {
            known.insert((trace, *id), depth);
        }
        depth += 1;
    }
    Ok(depth)
}

/// Which logs a log route asks for.
pub struct LogFilter<'a> {
    pub query: &'a Query,
    /// `/api/traces/:id/logs`: the trace; the lookback applies as on the other routes.
    pub trace: Option<&'a str>,
}

/// `GET /api/logs`, `/api/logs/search` and `/api/traces/:traceId/logs`: logs newest first.
pub fn logs(connection: &Connection, out: &mut Out, filter: LogFilter) -> Result<(), Stop> {
    let query = filter.query;
    let limit = query.limit(LOG_LIST);
    let lookback = query.lookback_minutes();
    let mut sql = Sql::new();
    let trace = filter.trace.or_else(|| query.filter("traceId"));
    sql.and(
        "l.time_ns >= ?",
        [SqlValue::Integer(
            (now_ms() - lookback * 60_000) * 1_000_000,
        )],
    );
    if let Some(trace) = trace {
        match exact_id::<16>(trace) {
            Some(id) => sql.and("l.trace_id = ?", [SqlValue::Blob(id.to_vec())]),
            None => sql.and("0", []),
        }
    }
    if filter.trace.is_none() {
        if let Some(span) = query.filter("spanId") {
            match exact_id::<8>(span) {
                Some(id) => sql.and("l.span_id = ?", [SqlValue::Blob(id.to_vec())]),
                None => sql.and("0", []),
            }
        }
        if let Some(service) = query.filter("service") {
            sql.and(
                // `+` keeps SQLite on the time index, newest first, stopping at the limit, rather
                // than reading every log of the service in the window to sort them.
                "+l.resource IN (SELECT id FROM resources WHERE service_name = ?)",
                [SqlValue::Text(service.to_owned())],
            );
        }
        if let Some(severity) = query.filter("severity") {
            sql.and(
                "l.severity_text = ? COLLATE NOCASE",
                // JavaScript's `toUpperCase`: full Unicode case mapping, as Rust's.
                [SqlValue::Text(severity.to_uppercase())],
            );
        }
        attribute_clauses(
            &mut sql,
            &query.attributes(),
            "l.attributes_json",
            "r.attributes_json",
        );
    }
    let cursor = match LogCursor::decode(query.get("cursor")) {
        Ok(cursor) => cursor,
        Err(message) => return refuse(out, message),
    };
    if let Some(cursor) = cursor {
        sql.and(
            // A row value, so SQLite continues along the index instead of sorting what is left.
            "(l.time_ns, l.id) < (?, ?)",
            [SqlValue::Integer(cursor.ns), SqlValue::Integer(cursor.id)],
        );
    }
    if let Some((_, trace_id)) = evicting(connection)? {
        sql.and("l.trace_id IS NOT ?", [SqlValue::Blob(trace_id)]);
    }
    let body = if filter.trace.is_none() {
        query.filter("body").map(TextMatch::new)
    } else {
        None
    };
    let text = format!(
        "SELECT l.id, l.time_ns, r.service_name, l.severity_text, l.body, l.trace_id, l.span_id, l.scope_name, l.attributes_json, l.resource
         FROM logs AS l JOIN resources AS r ON r.id = l.resource {} ORDER BY l.time_ns DESC, l.id DESC",
        sql.filter()
    );
    let mut statement = connection.prepare(&text)?;
    let mut rows = statement.query(params_from_iter(sql.values.iter()))?;
    let mut resources = Resources::new();
    out.start(StatusCode::OK)?;
    out.text("{\"data\":[")?;
    let (mut returned, mut truncated, mut last, mut scanned) = (0usize, false, None, 0u64);
    while let Some(row) = rows.next()? {
        scanned += 1;
        if scanned.is_multiple_of(CHECK_ROWS as u64) {
            out.check()?;
        }
        if let Some(body) = &body
            && !body.matches(
                row.get_ref(4)?.as_str().map_err(rusqlite::Error::from)?,
                out,
            )?
        {
            continue;
        }
        if returned as i64 == limit {
            truncated = true;
            break;
        }
        if returned > 0 {
            out.text(",")?;
        }
        let (id, time): (i64, i64) = (row.get(0)?, row.get(1)?);
        let resource: i64 = row.get(9)?;
        let attributes: String = row.get(8)?;
        let resource = resources.get(connection, resource)?;
        let (_, resource_attributes) = &*resource;
        // Keys in the order a JSON value of the item would have; the text read straight from
        // the row.
        let text = |index: usize| -> rusqlite::Result<&str> {
            row.get_ref(index)?.as_str().map_err(rusqlite::Error::from)
        };
        out.text("{\"attributes\":")?;
        write_merged(out, resource_attributes, &attributes)?;
        out.text(",\"body\":")?;
        out.json(text(4)?)?;
        out.text(",\"id\":")?;
        out.json(&id.to_string())?;
        out.text(",\"scopeName\":")?;
        out.json(
            &row.get_ref(7)?
                .as_str_or_null()
                .map_err(rusqlite::Error::from)?,
        )?;
        out.text(",\"serviceName\":")?;
        out.json(text(2)?)?;
        out.text(",\"severityText\":")?;
        out.json(text(3)?)?;
        out.text(",\"spanId\":")?;
        out.json(
            &row.get_ref(6)?
                .as_blob_or_null()
                .map_err(rusqlite::Error::from)?
                .map(hex),
        )?;
        out.text(",\"timestamp\":")?;
        out.json(&iso(ms(time)))?;
        out.text(",\"traceId\":")?;
        out.json(
            &row.get_ref(5)?
                .as_blob_or_null()
                .map_err(rusqlite::Error::from)?
                .map(hex),
        )?;
        out.text("}")?;
        returned += 1;
        last = Some(LogCursor { ns: time, id });
    }
    out.text("],\"meta\":")?;
    out.json(&meta(
        limit,
        lookback,
        returned,
        truncated,
        last.map(|cursor| cursor.encode()),
    ))?;
    out.text("}")
}
