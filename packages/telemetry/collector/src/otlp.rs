//! OTLP/HTTP JSON exports, decoded into the rows the store keeps.
//!
//! Only the fields the collector stores are decoded; serde ignores the rest. The mapping follows
//! what Motel stored, so the same exports read back the same way:
//!
//! - Attribute values become strings: arrays are joined with a space, key-value lists become JSON,
//!   bytes stay base64. `intValue` keeps its decimal digits; Motel turned it into a JavaScript
//!   number first and lost precision above 2^53.
//! - A value inside more than [`VALUE_DEPTH`] arrays and key-value lists is kept as its JSON
//!   text instead, so no depth refuses an export.
//! - Trace and span ids are hex of the right length, in either case, or canonical base64. A span
//!   whose id is neither makes the export invalid. A log's ids only correlate it with a span, so
//!   an id that cannot be read is dropped instead.
//! - The service name is `service.name`, then `service_name`, then `unknown`.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;

/// Why an export could not be decoded. The message is returned to the sender.
#[derive(Debug)]
pub struct Invalid(pub String);

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

// --- The wire format -------------------------------------------------------------------------
//
// Strings borrow from the request body where they need no unescaping, so decoding allocates
// little beyond the rows it produces.

type Text<'a> = Cow<'a, str>;

/// A whole number, in any form ProtoJSON allows for an integer field: a JSON number or a string
/// holding one, with or without a fraction part or an exponent (`100`, `"100"`, `1e2`, `"1e2"`,
/// `"100.0"`, `"1000e-1"`), as long as its value is whole. Each field checks the range. `None`
/// is an empty string, which ProtoJSON calls invalid; timestamps keep Motel's reading of it as 0.
///
/// A string is read exactly. A number with a fraction part or exponent arrives as a double, so it
/// is exact only up to 2^53, as in any JSON reader that parses numbers as doubles.
struct Whole(Option<i128>);

impl<'de> Deserialize<'de> for Whole {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(WholeVisitor)
    }
}

struct WholeVisitor;

impl serde::de::Visitor<'_> for WholeVisitor {
    type Value = Whole;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a whole number, as a JSON number or a string")
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Whole, E> {
        Ok(Whole(Some(value.into())))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Whole, E> {
        Ok(Whole(Some(value.into())))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Whole, E> {
        // Every double this large is whole and outside every field's range.
        if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e38 {
            Ok(Whole(Some(value as i128)))
        } else {
            Err(E::custom(format!("{value} is not a whole number in range")))
        }
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Whole, E> {
        if value.is_empty() {
            return Ok(Whole(None));
        }
        whole_number(value)
            .map(|number| Whole(Some(number)))
            .ok_or_else(|| E::custom(format!("{value:?} is not a whole number in range")))
    }
}

/// The exact value of a decimal number written as text, when it is whole: an optional sign, digits
/// with an optional fraction part, and an optional exponent. `None` when it is not a number, not
/// whole, or beyond `i128`.
pub fn whole_number(text: &str) -> Option<i128> {
    let (negative, rest) = match text.as_bytes().first()? {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(at) => (&rest[..at], Some(&rest[at + 1..])),
        None => (rest, None),
    };
    let (whole_part, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits_only = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if (whole_part.is_empty() && fraction.is_empty())
        || !digits_only(whole_part)
        || !digits_only(fraction)
    {
        return None;
    }
    // The exponent, exactly, or 10^20 when it is larger. Every string is shorter than
    // usize::MAX < 10^20 bytes, so a larger exponent cannot be cancelled by the digits: it gives
    // the same answer as 10^20 (too large, or not whole unless the digits are all zero).
    let exponent: i128 = match exponent {
        None => 0,
        Some(exponent) => {
            let (sign, digits) = match exponent.as_bytes().first()? {
                b'-' => (-1, &exponent[1..]),
                b'+' => (1, &exponent[1..]),
                _ => (1, exponent),
            };
            if digits.is_empty() || !digits_only(digits) {
                return None;
            }
            let significant = digits.trim_start_matches('0');
            let magnitude: i128 = if significant.len() > 20 {
                10_i128.pow(20)
            } else {
                significant
                    .parse::<i128>()
                    .unwrap_or(0)
                    .min(10_i128.pow(20))
            };
            sign * magnitude
        }
    };
    let joined = format!("{whole_part}{fraction}");
    let significant = joined.trim_start_matches('0');
    if significant.is_empty() {
        return Some(0);
    }
    let shift = exponent - fraction.len() as i128;
    let magnitude: u128 = if shift < 0 {
        let cut = usize::try_from(-shift).ok()?;
        let keep = significant.len().checked_sub(cut)?;
        if !significant[keep..].bytes().all(|byte| byte == b'0') {
            return None;
        }
        significant[..keep].parse().ok()?
    } else {
        let zeros = usize::try_from(shift).ok()?;
        if significant.len() + zeros > 39 {
            return None;
        }
        format!("{significant}{}", "0".repeat(zeros)).parse().ok()?
    };
    let magnitude = i128::try_from(magnitude).ok()?;
    Some(if negative { -magnitude } else { magnitude })
}

/// A whole number in the range of `T`, or why the export is invalid.
fn in_range<T: TryFrom<i128>>(value: Option<i128>, field: &str) -> Result<T, Invalid> {
    value
        .and_then(|value| T::try_from(value).ok())
        .ok_or_else(|| Invalid(format!("{field} is empty or out of range")))
}

#[derive(Deserialize)]
struct KeyValue<'a> {
    #[serde(borrow)]
    key: Text<'a>,
    /// Read as text here and decoded by [`parse`], so its depth does not count against the
    /// export's.
    #[serde(borrow)]
    value: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Resource<'a> {
    #[serde(borrow)]
    attributes: Option<Vec<KeyValue<'a>>>,
}

#[derive(Deserialize)]
struct Scope<'a> {
    #[serde(borrow)]
    name: Option<Text<'a>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceExport<'a> {
    #[serde(borrow)]
    resource_spans: Option<Vec<ResourceSpans<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceSpans<'a> {
    #[serde(borrow)]
    resource: Option<Resource<'a>>,
    #[serde(borrow)]
    scope_spans: Option<Vec<ScopeSpans<'a>>>,
}

#[derive(Deserialize)]
struct ScopeSpans<'a> {
    #[serde(borrow)]
    scope: Option<Scope<'a>>,
    #[serde(borrow)]
    spans: Option<Vec<Span<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Span<'a> {
    #[serde(borrow)]
    trace_id: Text<'a>,
    #[serde(borrow)]
    span_id: Text<'a>,
    #[serde(borrow)]
    parent_span_id: Option<Text<'a>>,
    #[serde(borrow)]
    name: Option<Text<'a>>,
    kind: Option<Whole>,
    start_time_unix_nano: Option<Whole>,
    end_time_unix_nano: Option<Whole>,
    #[serde(borrow)]
    attributes: Option<Vec<KeyValue<'a>>>,
    status: Option<Status>,
    #[serde(borrow)]
    events: Option<Vec<Event<'a>>>,
}

#[derive(Deserialize)]
struct Status {
    code: Option<Whole>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event<'a> {
    time_unix_nano: Option<Whole>,
    #[serde(borrow)]
    name: Option<Text<'a>>,
    #[serde(borrow)]
    attributes: Option<Vec<KeyValue<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogExport<'a> {
    #[serde(borrow)]
    resource_logs: Option<Vec<ResourceLogs<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLogs<'a> {
    #[serde(borrow)]
    resource: Option<Resource<'a>>,
    #[serde(borrow)]
    scope_logs: Option<Vec<ScopeLogs<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeLogs<'a> {
    #[serde(borrow)]
    scope: Option<Scope<'a>>,
    #[serde(borrow)]
    log_records: Option<Vec<LogRecord<'a>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogRecord<'a> {
    time_unix_nano: Option<Whole>,
    observed_time_unix_nano: Option<Whole>,
    #[serde(borrow)]
    severity_text: Option<Text<'a>>,
    #[serde(borrow)]
    body: Option<&'a RawValue>,
    #[serde(borrow)]
    attributes: Option<Vec<KeyValue<'a>>>,
    #[serde(borrow)]
    trace_id: Option<Text<'a>>,
    #[serde(borrow)]
    span_id: Option<Text<'a>>,
}

// --- What the store keeps --------------------------------------------------------------------

/// A resource: its attributes as canonical JSON (sorted keys, compact) and its service name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceRow {
    pub attributes_json: String,
    pub service_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpanRow {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub parent_span_id: Option<[u8; 8]>,
    pub scope_name: Option<String>,
    pub name: String,
    /// 1 to 5; any other kind is stored as unknown.
    pub kind: Option<i64>,
    pub start_ns: i64,
    pub end_ns: i64,
    /// 1 when the span's status code is error (2), otherwise 0.
    pub status: i64,
    /// The span's own attributes as canonical JSON.
    pub attributes_json: String,
    /// `[{name, timeNs, attributes}]`, or none when the span has no events.
    pub events_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogRow {
    pub trace_id: Option<[u8; 16]>,
    pub span_id: Option<[u8; 8]>,
    pub scope_name: Option<String>,
    pub severity_text: String,
    pub time_ns: i64,
    pub body: String,
    pub attributes_json: String,
}

/// The spans of one export, grouped by resource.
#[derive(Debug, Default)]
pub struct Spans {
    pub groups: Vec<(ResourceRow, Vec<SpanRow>)>,
}

/// The log records of one export, grouped by resource.
#[derive(Debug, Default)]
pub struct Logs {
    pub groups: Vec<(ResourceRow, Vec<LogRow>)>,
}

/// Decode a `/v1/traces` body.
pub fn decode_spans(body: &[u8]) -> Result<Spans, Invalid> {
    let export: TraceExport = serde_json::from_slice(body)
        .map_err(|error| Invalid(format!("Invalid traces export: {error}")))?;
    let mut out = Spans::default();
    for resource_spans in export.resource_spans.unwrap_or_default() {
        let resource = resource_row(resource_spans.resource)?;
        let mut rows = Vec::new();
        for scope_spans in resource_spans.scope_spans.unwrap_or_default() {
            let scope_name = scope_spans
                .scope
                .and_then(|scope| scope.name)
                .map(Cow::into_owned);
            for span in scope_spans.spans.unwrap_or_default() {
                rows.push(span_row(span, scope_name.clone())?);
            }
        }
        out.groups.push((resource, rows));
    }
    Ok(out)
}

/// Decode a `/v1/logs` body.
pub fn decode_logs(body: &[u8]) -> Result<Logs, Invalid> {
    let export: LogExport = serde_json::from_slice(body)
        .map_err(|error| Invalid(format!("Invalid logs export: {error}")))?;
    let mut out = Logs::default();
    for resource_logs in export.resource_logs.unwrap_or_default() {
        let resource = resource_row(resource_logs.resource)?;
        let mut rows = Vec::new();
        for scope_logs in resource_logs.scope_logs.unwrap_or_default() {
            let scope_name = scope_logs
                .scope
                .and_then(|scope| scope.name)
                .map(Cow::into_owned);
            for record in scope_logs.log_records.unwrap_or_default() {
                rows.push(log_row(record, scope_name.clone())?);
            }
        }
        out.groups.push((resource, rows));
    }
    Ok(out)
}

fn resource_row(resource: Option<Resource<'_>>) -> Result<ResourceRow, Invalid> {
    let attributes = attribute_map(resource.and_then(|resource| resource.attributes))?;
    let service_name = [
        attributes.get("service.name"),
        attributes.get("service_name"),
    ]
    .into_iter()
    .flatten()
    .find(|name| !name.is_empty())
    .map_or_else(|| "unknown".to_owned(), |name| name.clone().into_owned());
    Ok(ResourceRow {
        attributes_json: canonical_json(&attributes),
        service_name,
    })
}

fn span_row(span: Span<'_>, scope_name: Option<String>) -> Result<SpanRow, Invalid> {
    let trace_id = binary_id::<16>(&span.trace_id)
        .ok_or_else(|| Invalid(format!("Invalid trace id {:?}", span.trace_id)))?;
    let span_id = binary_id::<8>(&span.span_id)
        .ok_or_else(|| Invalid(format!("Invalid span id {:?}", span.span_id)))?;
    let parent_span_id = match span.parent_span_id.as_deref() {
        None | Some("") => None,
        Some(parent) => Some(
            binary_id::<8>(parent)
                .ok_or_else(|| Invalid(format!("Invalid parent span id {parent:?}")))?,
        ),
    };
    let events = span.events.unwrap_or_default();
    let events_json = if events.is_empty() {
        None
    } else {
        let mut json = String::from("[");
        for (index, event) in events.into_iter().enumerate() {
            if index > 0 {
                json.push(',');
            }
            json.push_str("{\"name\":");
            json_string(&mut json, event.name.as_deref().unwrap_or("event"));
            json.push_str(",\"timeNs\":");
            json.push_str(&nanos(event.time_unix_nano)?.to_string());
            json.push_str(",\"attributes\":");
            json.push_str(&canonical_json(&attribute_map(event.attributes)?));
            json.push('}');
        }
        json.push(']');
        Some(json)
    };
    Ok(SpanRow {
        trace_id,
        span_id,
        parent_span_id,
        scope_name,
        name: span
            .name
            .map_or_else(|| "unknown".to_owned(), Cow::into_owned),
        kind: match span.kind {
            Some(kind) => Some(i64::from(in_range::<i32>(kind.0, "kind")?))
                .filter(|kind| (1..=5).contains(kind)),
            None => None,
        },
        start_ns: nanos(span.start_time_unix_nano)?,
        end_ns: nanos(span.end_time_unix_nano)?,
        status: match span.status.and_then(|status| status.code) {
            Some(code) => i64::from(in_range::<i32>(code.0, "status code")? == 2),
            None => 0,
        },
        attributes_json: canonical_json(&attribute_map(span.attributes)?),
        events_json,
    })
}

fn log_row(record: LogRecord<'_>, scope_name: Option<String>) -> Result<LogRow, Invalid> {
    let attributes = attribute_map(record.attributes)?;
    let from_attributes = |keys: [&str; 2]| {
        keys.iter()
            .filter_map(|key| attributes.get(*key))
            .find(|value| !value.is_empty())
            .map(|value| value.as_ref())
    };
    let trace_id = from_attributes(["traceId", "trace_id"])
        .or(record.trace_id.as_deref())
        .and_then(binary_id::<16>);
    let span_id = from_attributes(["spanId", "span_id"])
        .or(record.span_id.as_deref())
        .and_then(binary_id::<8>);
    let time_ns = match nanos(record.time_unix_nano)? {
        0 => nanos(record.observed_time_unix_nano)?,
        time => time,
    };
    Ok(LogRow {
        trace_id,
        span_id,
        scope_name,
        severity_text: record
            .severity_text
            .map_or_else(|| "INFO".to_owned(), Cow::into_owned),
        time_ns,
        body: match record.body {
            Some(body) => stringify(parse(body)?).into_owned(),
            None => String::new(),
        },
        attributes_json: canonical_json(&attributes),
    })
}

/// A count of nanoseconds since the epoch. Missing is 0, as in Motel.
/// A count of nanoseconds since the epoch: an unsigned 64-bit field, stored as a signed one.
/// Missing or empty is 0, as in Motel.
fn nanos(value: Option<Whole>) -> Result<i64, Invalid> {
    match value {
        None | Some(Whole(None)) => Ok(0),
        Some(Whole(Some(nanos))) => i64::try_from(nanos)
            .ok()
            .filter(|nanos| *nanos >= 0)
            .ok_or_else(|| Invalid(format!("Time {nanos} is out of range"))),
    }
}

// --- Attribute values ------------------------------------------------------------------------

/// An `AnyValue` after Motel's `parseAnyValue`, before it is made a string.
#[derive(Debug, PartialEq)]
enum Value<'a> {
    Null,
    Text(Text<'a>),
    Bool(bool),
    /// Decimal digits of an `intValue`, kept exactly.
    Int(String),
    Double(f64),
    Array(Vec<Value<'a>>),
    /// Entries in the order JavaScript's `Object.fromEntries` keeps: first position, last value.
    Object(Vec<(Text<'a>, Value<'a>)>),
}

/// How many arrays and key-value lists deep a value is decoded. A value inside more of them than
/// this is kept as its `AnyValue`'s JSON text, exactly as the export spelled it, in the place its
/// value would have had.
///
/// Decoding a value recurses once per level, in serde_json and here, and so do making it a string
/// and dropping it. Values decode on the runtime's blocking threads, which `main` gives
/// `DECODE_STACK` of stack. Measured on x86-64 Linux, a value inside 64 key-value lists needs about
/// 91 KiB in a release build and 544 KiB in a debug build (arrays: 91 KiB and 410 KiB); each level
/// adds about 1.3 KiB and 8.2 KiB. The tests decode values at and past this depth on a 1 MiB
/// thread. Text past the limit is read without recursion (serde_json keeps one byte per open
/// bracket), so its depth is bounded only by the export's size, and costs no stack.
///
/// The pinned Effect exporter writes nested user data as nested values; 40 levels of arrays is
/// 1,315 bytes.
pub const VALUE_DEPTH: usize = 64;

/// The stack of every thread that decodes an export. The runtime is built with it, so it does not
/// depend on `RUST_MIN_STACK`: with 64 KiB there, a value 64 key-value lists deep overflowed the
/// stack and ended the process.
pub const DECODE_STACK: usize = 2 * 1024 * 1024;

/// Decode one attribute value or log body, as Motel's `parseAnyValue` read it.
///
/// The export's reader keeps the value as text, which serde_json reads without recursion, and keeps
/// its own 128-level limit for everything else. The value then gets its own reader, with
/// serde_json's limit (128 levels of JSON, about 40 levels of arrays) off: the only recursion in it
/// is through [`AnyValueSeed`], which stops at [`VALUE_DEPTH`]. Every other field it reads is a
/// scalar, and a field it skips is read without recursion.
fn parse(value: &RawValue) -> Result<Value<'_>, Invalid> {
    let mut reader = serde_json::Deserializer::from_str(value.get());
    reader.disable_recursion_limit();
    let parsed = AnyValueSeed { depth: 0 }
        .deserialize(&mut reader)
        .and_then(|parsed| reader.end().map(|()| parsed))
        .map_err(|error| Invalid(format!("Invalid value: {error}")))?;
    Ok(parsed)
}

/// The names of the fields an `AnyValue`, an array or a key-value list has; anything else is
/// skipped.
enum Field {
    StringValue,
    BoolValue,
    IntValue,
    DoubleValue,
    BytesValue,
    ArrayValue,
    KvlistValue,
    Values,
    Key,
    Value,
    Other,
}

impl<'de> Deserialize<'de> for Field {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldVisitor;
        impl Visitor<'_> for FieldVisitor {
            type Value = Field;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a field name")
            }
            fn visit_str<E: serde::de::Error>(self, name: &str) -> Result<Field, E> {
                Ok(match name {
                    "stringValue" => Field::StringValue,
                    "boolValue" => Field::BoolValue,
                    "intValue" => Field::IntValue,
                    "doubleValue" => Field::DoubleValue,
                    "bytesValue" => Field::BytesValue,
                    "arrayValue" => Field::ArrayValue,
                    "kvlistValue" => Field::KvlistValue,
                    "values" => Field::Values,
                    "key" => Field::Key,
                    "value" => Field::Value,
                    _ => Field::Other,
                })
            }
        }
        deserializer.deserialize_identifier(FieldVisitor)
    }
}

/// A string that borrows from the export when it needs no unescaping.
#[derive(Deserialize)]
struct Borrowed<'a>(#[serde(borrow)] Text<'a>);

/// Store `value` in `slot`, refusing a field given twice as a derived struct does.
fn once<T, E: serde::de::Error>(
    slot: &mut Option<T>,
    value: T,
    name: &'static str,
) -> Result<(), E> {
    if slot.is_some() {
        return Err(E::duplicate_field(name));
    }
    *slot = Some(value);
    Ok(())
}

/// Reads an `AnyValue` inside `depth` arrays and key-value lists into a [`Value`].
#[derive(Clone, Copy)]
struct AnyValueSeed {
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for AnyValueSeed {
    type Value = Value<'de>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Value<'de>, D::Error> {
        if self.depth > VALUE_DEPTH {
            // serde_json reads a raw value with a loop and a byte per open bracket, not recursion.
            let text = <&RawValue>::deserialize(deserializer)?;
            return Ok(Value::Text(Cow::Borrowed(text.get())));
        }
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for AnyValueSeed {
    type Value = Value<'de>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("an AnyValue object")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Value<'de>, M::Error> {
        let mut string_value = None;
        let mut bool_value = None;
        let mut int_value = None;
        let mut double_value = None;
        let mut bytes_value = None;
        let mut array_value = None;
        let mut kvlist_value = None;
        let inner = ListSeed {
            depth: self.depth + 1,
            entries: false,
        };
        while let Some(field) = map.next_key::<Field>()? {
            match field {
                Field::StringValue => {
                    let text = map.next_value::<Option<Borrowed>>()?;
                    once(&mut string_value, text, "stringValue")?;
                }
                Field::BoolValue => {
                    let flag = map.next_value::<Option<bool>>()?;
                    once(&mut bool_value, flag, "boolValue")?;
                }
                Field::IntValue => {
                    let int = map.next_value::<Option<Whole>>()?;
                    once(&mut int_value, int, "intValue")?;
                }
                Field::DoubleValue => {
                    let double = map.next_value::<Option<Double>>()?;
                    once(&mut double_value, double, "doubleValue")?;
                }
                Field::BytesValue => {
                    let bytes = map.next_value::<Option<Borrowed>>()?;
                    once(&mut bytes_value, bytes, "bytesValue")?;
                }
                Field::ArrayValue => {
                    let array = map.next_value_seed(OptionSeed(inner))?;
                    once(&mut array_value, array, "arrayValue")?;
                }
                Field::KvlistValue => {
                    let list = map.next_value_seed(OptionSeed(ListSeed {
                        entries: true,
                        ..inner
                    }))?;
                    once(&mut kvlist_value, list, "kvlistValue")?;
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        // Motel's order: the first field that is set wins.
        if let Some(Borrowed(text)) = string_value.flatten() {
            return Ok(Value::Text(text));
        }
        if let Some(flag) = bool_value.flatten() {
            return Ok(Value::Bool(flag));
        }
        if let Some(int) = int_value.flatten() {
            return in_range::<i64>(int.0, "intValue")
                .map(|int| Value::Int(int.to_string()))
                .map_err(|Invalid(message)| serde::de::Error::custom(message));
        }
        if let Some(Double(double)) = double_value.flatten() {
            return Ok(Value::Double(double));
        }
        if let Some(Borrowed(bytes)) = bytes_value.flatten() {
            return Ok(Value::Text(bytes));
        }
        if let Some(Some(list)) = array_value.flatten() {
            return Ok(list);
        }
        if let Some(Some(list)) = kvlist_value.flatten() {
            return Ok(list);
        }
        Ok(Value::Null)
    }
}

/// `null` or what `T` reads.
struct OptionSeed<T>(T);

impl<'de, T: DeserializeSeed<'de> + Copy> DeserializeSeed<'de> for OptionSeed<T> {
    type Value = Option<T::Value>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_option(self)
    }
}

impl<'de, T: DeserializeSeed<'de> + Copy> Visitor<'de> for OptionSeed<T> {
    type Value = Option<T::Value>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("null or a value")
    }

    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_some<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        self.0.deserialize(deserializer).map(Some)
    }
}

/// Reads an `ArrayValue` or a `KeyValueList` (`{"values": [...]}`) whose entries are inside
/// `depth` of them. `None` when it has no `values`, which Motel read as null.
#[derive(Clone, Copy)]
struct ListSeed {
    depth: usize,
    entries: bool,
}

impl<'de> DeserializeSeed<'de> for ListSeed {
    type Value = Option<Value<'de>>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for ListSeed {
    type Value = Option<Value<'de>>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str(if self.entries {
            "a KeyValueList object"
        } else {
            "an ArrayValue object"
        })
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut values = None;
        while let Some(field) = map.next_key::<Field>()? {
            if let Field::Values = field {
                let list = map.next_value_seed(OptionSeed(Entries(self)))?;
                once(&mut values, list, "values")?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(values.flatten())
    }
}

/// The `values` of a [`ListSeed`].
#[derive(Clone, Copy)]
struct Entries(ListSeed);

impl<'de> DeserializeSeed<'de> for Entries {
    type Value = Value<'de>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Value<'de>, D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for Entries {
    type Value = Value<'de>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a list of values")
    }

    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> Result<Value<'de>, S::Error> {
        let seed = AnyValueSeed {
            depth: self.0.depth,
        };
        if !self.0.entries {
            let mut values = Vec::new();
            while let Some(value) = seq.next_element_seed(seed)? {
                values.push(value);
            }
            return Ok(Value::Array(values));
        }
        let mut object: Vec<(Text, Value)> = Vec::new();
        // Each key's place in `object`, so a repeated key is found without a scan.
        let mut places: HashMap<Text, usize> = HashMap::new();
        while let Some((key, value)) = seq.next_element_seed(EntrySeed(seed))? {
            match places.get(&key) {
                Some(&place) => object[place].1 = value,
                None => {
                    places.insert(key.clone(), object.len());
                    object.push((key, value));
                }
            }
        }
        Ok(Value::Object(object))
    }
}

/// One `KeyValue` of a key-value list: its key and its value, null when it has none.
#[derive(Clone, Copy)]
struct EntrySeed(AnyValueSeed);

impl<'de> DeserializeSeed<'de> for EntrySeed {
    type Value = (Text<'de>, Value<'de>);

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for EntrySeed {
    type Value = (Text<'de>, Value<'de>);

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a KeyValue object")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut key = None;
        let mut value = None;
        while let Some(field) = map.next_key::<Field>()? {
            match field {
                Field::Key => {
                    let Borrowed(text) = map.next_value()?;
                    once(&mut key, text, "key")?;
                }
                Field::Value => {
                    let parsed = map.next_value_seed(OptionSeed(self.0))?;
                    once(&mut value, parsed, "value")?;
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        let key = key.ok_or_else(|| serde::de::Error::missing_field("key"))?;
        Ok((key, value.flatten().unwrap_or(Value::Null)))
    }
}

/// A `doubleValue`. ProtoJSON writes a double as a number, or as a string: `"NaN"`,
/// `"Infinity"`, `"-Infinity"` or a decimal number in quotes.
struct Double(f64);

impl<'de> Deserialize<'de> for Double {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(DoubleVisitor)
    }
}

struct DoubleVisitor;

impl Visitor<'_> for DoubleVisitor {
    type Value = Double;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a double, as a JSON number or a string")
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Double, E> {
        Ok(Double(value))
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Double, E> {
        Ok(Double(value as f64))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Double, E> {
        Ok(Double(value as f64))
    }

    fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Double, E> {
        let invalid = || E::custom(format!("Invalid doubleValue {text:?}"));
        Ok(Double(match text {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            // Rust's parser also takes words such as "inf"; ProtoJSON allows only digits.
            digits
                if digits
                    .bytes()
                    .any(|byte| byte.is_ascii_alphabetic() && byte != b'e' && byte != b'E') =>
            {
                return Err(invalid());
            }
            digits => digits.parse::<f64>().map_err(|_| invalid())?,
        }))
    }
}

/// Motel's `stringifyValue`: how an attribute value is stored and shown.
fn stringify(value: Value<'_>) -> Text<'_> {
    match value {
        Value::Null => Cow::Borrowed(""),
        Value::Text(text) => text,
        Value::Bool(flag) => Cow::Borrowed(if flag { "true" } else { "false" }),
        Value::Int(digits) => Cow::Owned(digits),
        Value::Double(double) => Cow::Owned(js_number(double)),
        nested => {
            let mut text = String::new();
            write_text(&mut text, &nested);
            Cow::Owned(text)
        }
    }
}

/// `stringify`, written into one buffer, so nested arrays are not copied once per level. An
/// array's non-empty entries are joined with a space.
fn write_text(out: &mut String, value: &Value<'_>) {
    match value {
        Value::Null => {}
        Value::Text(text) => out.push_str(text),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Int(digits) => out.push_str(digits),
        Value::Double(double) => out.push_str(&js_number(*double)),
        Value::Array(values) => {
            let mut wrote = false;
            for entry in values {
                let mark = out.len();
                if wrote {
                    out.push(' ');
                }
                let start = out.len();
                write_text(out, entry);
                if out.len() == start {
                    out.truncate(mark);
                } else {
                    wrote = true;
                }
            }
        }
        Value::Object(_) => write_json(out, value),
    }
}

/// JavaScript's `JSON.stringify` of a parsed value.
fn write_json(out: &mut String, value: &Value<'_>) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Text(text) => json_string(out, text),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Int(digits) => out.push_str(digits),
        Value::Double(double) if double.is_finite() => out.push_str(&js_number(*double)),
        Value::Double(_) => out.push_str("null"),
        Value::Array(values) => {
            out.push('[');
            for (index, entry) in values.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(out, entry);
            }
            out.push(']');
        }
        Value::Object(entries) => {
            out.push('{');
            for (index, (key, entry)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                json_string(out, key);
                out.push(':');
                write_json(out, entry);
            }
            out.push('}');
        }
    }
}

/// JavaScript's `String(number)`.
fn js_number(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}

fn json_string(out: &mut String, text: &str) {
    // Serializing a string cannot fail.
    out.push_str(&serde_json::to_string(text).unwrap_or_default());
}

/// Attributes as Motel's `attributeMap`: each key to its value as a string; a repeated key keeps
/// its last value.
fn attribute_map(
    attributes: Option<Vec<KeyValue<'_>>>,
) -> Result<BTreeMap<Text<'_>, Text<'_>>, Invalid> {
    let mut map = BTreeMap::new();
    for attribute in attributes.unwrap_or_default() {
        let value = match attribute.value {
            Some(value) => stringify(parse(value)?),
            None => Cow::Borrowed(""),
        };
        map.insert(attribute.key, value);
    }
    Ok(map)
}

/// Compact JSON with sorted keys, so equal attributes always have equal text.
fn canonical_json(map: &BTreeMap<Text<'_>, Text<'_>>) -> String {
    serde_json::to_string(map).unwrap_or_default()
}

// --- Ids -------------------------------------------------------------------------------------

/// An OTLP id: hex of exactly `N` bytes in either case, or canonical base64 of `N` bytes.
pub fn binary_id<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.len() == N * 2 {
        let mut out = [0u8; N];
        let digits = text.as_bytes();
        let mut ok = true;
        for (index, byte) in out.iter_mut().enumerate() {
            match (
                hex_digit(digits[index * 2]),
                hex_digit(digits[index * 2 + 1]),
            ) {
                (Some(high), Some(low)) => *byte = high << 4 | low,
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            return Some(out);
        }
    }
    let bytes = base64_decode(text)?;
    let out: [u8; N] = bytes.try_into().ok()?;
    (base64_encode(&out) == text).then_some(out)
}

fn hex_digit(digit: u8) -> Option<u8> {
    match digit {
        b'0'..=b'9' => Some(digit - b'0'),
        b'a'..=b'f' => Some(digit - b'a' + 10),
        b'A'..=b'F' => Some(digit - b'A' + 10),
        _ => None,
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let word = u32::from(chunk[0]) << 16
            | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(char::from(BASE64[(word >> (18 - 6 * index) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() || !text.len().is_multiple_of(4) {
        return None;
    }
    let trimmed = text.trim_end_matches('=');
    if text.len() - trimmed.len() > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut word = 0u32;
    let mut bits = 0;
    for byte in trimmed.bytes() {
        let digit = BASE64.iter().position(|candidate| *candidate == byte)? as u32;
        word = word << 6 | digit;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((word >> bits) as u8);
            word &= (1 << bits) - 1;
        }
    }
    Some(out)
}
