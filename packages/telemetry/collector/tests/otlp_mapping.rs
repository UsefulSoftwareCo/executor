//! The OTLP/JSON field mapping: what each export field becomes in the store.

use executor_collector::otlp::{LogRow, SpanRow, decode_logs, decode_spans};
use serde_json::{Value, json};

const TRACE: &str = "0af7651916cd43dd8448eb211c80319c";
const SPAN: &str = "b7ad6b7169203331";

fn trace_bytes() -> [u8; 16] {
    [
        0x0a, 0xf7, 0x65, 0x19, 0x16, 0xcd, 0x43, 0xdd, 0x84, 0x48, 0xeb, 0x21, 0x1c, 0x80, 0x31,
        0x9c,
    ]
}

fn span_bytes() -> [u8; 8] {
    [0xb7, 0xad, 0x6b, 0x71, 0x69, 0x20, 0x33, 0x31]
}

fn traces(resource: Value, span: Value) -> Vec<u8> {
    json!({ "resourceSpans": [{ "resource": { "attributes": resource }, "scopeSpans": [{ "scope": { "name": "scope" }, "spans": [span] }] }] })
        .to_string()
        .into_bytes()
}

fn one_span(span: Value) -> SpanRow {
    let decoded = decode_spans(&traces(json!([]), span)).expect("decodes");
    decoded.groups[0].1[0].clone()
}

fn one_log(record: Value) -> LogRow {
    let body =
        json!({ "resourceLogs": [{ "scopeLogs": [{ "logRecords": [record] }] }] }).to_string();
    let decoded = decode_logs(body.as_bytes()).expect("decodes");
    decoded.groups[0].1[0].clone()
}

/// The span's attributes as stored, decoded back into a map.
fn attributes(values: Value) -> Value {
    let span = one_span(json!({ "traceId": TRACE, "spanId": SPAN, "attributes": values }));
    serde_json::from_str(&span.attributes_json).expect("stored attributes are JSON")
}

fn value(any: Value) -> Value {
    attributes(json!([{ "key": "v", "value": any }]))["v"].clone()
}

#[test]
fn ids_are_hex_in_either_case_or_canonical_base64() {
    let lower = one_span(json!({ "traceId": TRACE, "spanId": SPAN }));
    assert_eq!(lower.trace_id, trace_bytes());
    assert_eq!(lower.span_id, span_bytes());
    let upper = one_span(json!({ "traceId": TRACE.to_uppercase(), "spanId": SPAN.to_uppercase() }));
    assert_eq!(
        (upper.trace_id, upper.span_id),
        (trace_bytes(), span_bytes())
    );
    let base64 =
        one_span(json!({ "traceId": "CvdlGRbNQ92ESOshHIAxnA==", "spanId": "t61rcWkgMzE=" }));
    assert_eq!(
        (base64.trace_id, base64.span_id),
        (trace_bytes(), span_bytes())
    );
}

#[test]
fn a_span_with_an_unreadable_id_makes_the_export_invalid() {
    for (trace, span) in [
        ("trace-ai", SPAN),
        ("", SPAN),
        (TRACE, ""),
        (&TRACE[..30], SPAN),
        (TRACE, "b7ad6b716920333g"),
        // Base64 that is not canonical: the padding bits are not zero.
        ("CvdlGRbNQ92ESOshHIAxnB==", SPAN),
    ] {
        let export = traces(json!([]), json!({ "traceId": trace, "spanId": span }));
        assert!(
            decode_spans(&export).is_err(),
            "{trace:?} {span:?} should be refused"
        );
    }
    let bad_parent = traces(
        json!([]),
        json!({ "traceId": TRACE, "spanId": SPAN, "parentSpanId": "nope" }),
    );
    assert!(decode_spans(&bad_parent).is_err());
}

#[test]
fn an_empty_parent_is_a_root() {
    assert_eq!(
        one_span(json!({ "traceId": TRACE, "spanId": SPAN, "parentSpanId": "" })).parent_span_id,
        None
    );
    assert_eq!(
        one_span(json!({ "traceId": TRACE, "spanId": SPAN })).parent_span_id,
        None
    );
    assert_eq!(
        one_span(json!({ "traceId": TRACE, "spanId": SPAN, "parentSpanId": SPAN })).parent_span_id,
        Some(span_bytes())
    );
}

#[test]
fn attribute_values_become_strings_as_motel_stored_them() {
    assert_eq!(value(json!({ "stringValue": "text" })), json!("text"));
    assert_eq!(value(json!({ "boolValue": true })), json!("true"));
    assert_eq!(value(json!({ "boolValue": false })), json!("false"));
    assert_eq!(value(json!({ "intValue": "42" })), json!("42"));
    assert_eq!(value(json!({ "intValue": 42 })), json!("42"));
    assert_eq!(value(json!({ "intValue": "-7" })), json!("-7"));
    assert_eq!(value(json!({ "doubleValue": 0.1 })), json!("0.1"));
    assert_eq!(value(json!({ "doubleValue": 1.0 })), json!("1"));
    assert_eq!(value(json!({ "doubleValue": 1e21 })), json!("1e+21"));
    assert_eq!(value(json!({ "doubleValue": 1.5e-7 })), json!("1.5e-7"));
    assert_eq!(value(json!({ "bytesValue": "AAEC" })), json!("AAEC"));
    assert_eq!(value(json!({})), json!(""));
}

#[test]
fn double_values_may_be_protojson_strings() {
    assert_eq!(value(json!({ "doubleValue": "NaN" })), json!("NaN"));
    assert_eq!(
        value(json!({ "doubleValue": "Infinity" })),
        json!("Infinity")
    );
    assert_eq!(
        value(json!({ "doubleValue": "-Infinity" })),
        json!("-Infinity")
    );
    assert_eq!(value(json!({ "doubleValue": "1.5" })), json!("1.5"));
    assert_eq!(value(json!({ "doubleValue": "-2e3" })), json!("-2000"));
    // Inside a key-value list, as in JSON.stringify, a non-finite number is null.
    let list = json!({ "kvlistValue": { "values": [
        { "key": "n", "value": { "doubleValue": "NaN" } },
        { "key": "x", "value": { "doubleValue": "0.25" } },
    ] } });
    assert_eq!(value(list), json!(r#"{"n":null,"x":0.25}"#));
    for text in ["inf", "infinity", "nan", "1.5x", "", "0x10"] {
        let export = traces(
            json!([]),
            json!({ "traceId": TRACE, "spanId": SPAN, "attributes": [{ "key": "v", "value": { "doubleValue": text } }] }),
        );
        assert!(decode_spans(&export).is_err(), "{text:?} should be refused");
    }
}

#[test]
fn integers_take_every_protojson_form_with_a_whole_value() {
    for (form, expected) in [
        (json!("42"), "42"),
        (json!(42), "42"),
        (json!("1e2"), "100"),
        (json!(1e2), "100"),
        (json!("100e-2"), "1"),
        (json!("100.0"), "100"),
        (json!(100.0), "100"),
        (json!("1.5e1"), "15"),
        (json!("-7"), "-7"),
        (json!("+7"), "7"),
        (json!("0e999999999"), "0"),
        (json!("9223372036854775807"), "9223372036854775807"),
        (json!("9.223372036854775807e18"), "9223372036854775807"),
    ] {
        assert_eq!(
            value(json!({ "intValue": form })),
            json!(expected),
            "{form}"
        );
    }
}

#[test]
fn integers_that_are_not_whole_or_out_of_range_make_the_export_invalid() {
    for form in [
        json!(""),
        json!("1.5"),
        json!(1.5),
        json!("1e-1"),
        json!("9223372036854775808"),
        json!(9223372036854775808u64),
        json!("1e19"),
        json!("1e999999999"),
        json!("e2"),
        json!("1e"),
        json!("."),
        json!("0x10"),
        json!(" 1"),
        json!("1_000"),
        json!("NaN"),
        json!(true),
    ] {
        let export = traces(
            json!([]),
            json!({ "traceId": TRACE, "spanId": SPAN, "attributes": [{ "key": "v", "value": { "intValue": form } }] }),
        );
        assert!(
            decode_spans(&export).is_err(),
            "intValue {form} should be refused"
        );
    }
}

#[test]
fn timestamps_take_every_protojson_integer_form() {
    for (form, expected) in [
        (json!("1700000000000000000"), 1_700_000_000_000_000_000i64),
        (json!(1700000000000000000u64), 1_700_000_000_000_000_000),
        (json!("1.7e18"), 1_700_000_000_000_000_000),
        (json!(1.7e18), 1_700_000_000_000_000_000),
        (json!("1e2"), 100),
        (json!("100.0"), 100),
        (json!(""), 0),
    ] {
        let span = one_span(
            json!({ "traceId": TRACE, "spanId": SPAN, "startTimeUnixNano": form, "endTimeUnixNano": form }),
        );
        assert_eq!((span.start_ns, span.end_ns), (expected, expected), "{form}");
        let log = one_log(json!({ "timeUnixNano": form }));
        assert_eq!(log.time_ns, expected, "{form}");
    }
    for form in [
        json!("1.5"),
        json!(-1),
        json!("-1"),
        json!("1e19"),
        json!("9223372036854775808"),
        json!("soon"),
    ] {
        let export = traces(
            json!([]),
            json!({ "traceId": TRACE, "spanId": SPAN, "startTimeUnixNano": form }),
        );
        assert!(
            decode_spans(&export).is_err(),
            "time {form} should be refused"
        );
    }
}

/// An export with `token` written as-is, unquoted, where `__RAW__` stands. Building the body as
/// text keeps the number's spelling exactly as an exporter wrote it.
fn raw(template: &str, token: &str) -> Vec<u8> {
    template.replace("__RAW__", token).into_bytes()
}

const RAW_INT: &str = r#"{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"b7ad6b7169203331","attributes":[{"key":"v","value":{"intValue":__RAW__}}]}]}]}]}"#;
const RAW_START: &str = r#"{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"b7ad6b7169203331","startTimeUnixNano":__RAW__}]}]}]}"#;
const RAW_END: &str = r#"{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"b7ad6b7169203331","endTimeUnixNano":__RAW__}]}]}]}"#;
const RAW_EVENT: &str = r#"{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"b7ad6b7169203331","events":[{"timeUnixNano":__RAW__}]}]}]}]}"#;
const RAW_LOG_TIME: &str =
    r#"{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"timeUnixNano":__RAW__}]}]}]}"#;
const RAW_LOG_OBSERVED: &str =
    r#"{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"observedTimeUnixNano":__RAW__}]}]}]}"#;

/// Spellings of a whole number with a fraction part or an exponent, which reach the decoder as
/// doubles.
fn spellings(number: i128) -> Vec<String> {
    [
        ".0",
        ".000",
        ".0000000000",
        ".000000000000000000",
        "e0",
        "00e-2",
        "0e-1",
    ]
    .iter()
    .map(|suffix| format!("{number}{suffix}"))
    .collect()
}

/// Every whole number from 2^53 - 42 to 2^53, each of which a double holds exactly, and larger
/// ones that a double also holds exactly.
fn exact_doubles() -> Vec<i128> {
    let mut numbers: Vec<i128> = (9_007_199_254_740_950..=9_007_199_254_740_992).collect();
    numbers.extend([
        1 << 53,
        (1 << 54) + 4,
        1_700_000_000_000_000_256,
        4_611_686_018_427_387_904,
    ]);
    numbers
}

/// Whole numbers a double holds exactly keep their value however they are spelled. The default
/// decimal-to-double conversion stored some as a neighbour: `9007199254740991.0` became
/// `9007199254740990`.
#[test]
fn int_values_spelled_with_a_fraction_or_exponent_keep_their_exact_value() {
    for number in exact_doubles() {
        for token in spellings(number).iter().chain(spellings(-number).iter()) {
            let expected = token.parse::<f64>().expect("a number") as i128;
            assert_eq!(expected.abs(), number, "the test's own reading of {token}");
            let span = decode_spans(&raw(RAW_INT, token)).expect("decodes");
            assert_eq!(
                span.groups[0].1[0].attributes_json,
                format!(r#"{{"v":"{expected}"}}"#),
                "intValue {token}"
            );
        }
    }
}

#[test]
fn timestamps_spelled_with_a_fraction_or_exponent_keep_their_exact_value() {
    for number in exact_doubles() {
        let expected = number as i64;
        for token in spellings(number) {
            let span = |template| {
                decode_spans(&raw(template, &token))
                    .expect("decodes")
                    .groups[0]
                    .1[0]
                    .clone()
            };
            assert_eq!(
                span(RAW_START).start_ns,
                expected,
                "startTimeUnixNano {token}"
            );
            assert_eq!(span(RAW_END).end_ns, expected, "endTimeUnixNano {token}");
            let events = span(RAW_EVENT).events_json.expect("events");
            assert!(
                events.contains(&format!(r#""timeNs":{expected},"#)),
                "event timeUnixNano {token}: {events}"
            );
            let log = |template| {
                decode_logs(&raw(template, &token)).expect("decodes").groups[0].1[0].time_ns
            };
            assert_eq!(log(RAW_LOG_TIME), expected, "log timeUnixNano {token}");
            assert_eq!(
                log(RAW_LOG_OBSERVED),
                expected,
                "observedTimeUnixNano {token}"
            );
        }
        // Timestamps are unsigned: a negative one is refused however it is spelled.
        for token in spellings(-number) {
            assert!(
                decode_spans(&raw(RAW_START, &token)).is_err(),
                "startTimeUnixNano {token}"
            );
        }
    }
}

#[test]
fn kind_and_status_code_take_integer_forms() {
    let span = one_span(
        json!({ "traceId": TRACE, "spanId": SPAN, "kind": "2", "status": { "code": 2.0 } }),
    );
    assert_eq!((span.kind, span.status), (Some(2), 1));
    let span = one_span(
        json!({ "traceId": TRACE, "spanId": SPAN, "kind": "3e0", "status": { "code": "2" } }),
    );
    assert_eq!((span.kind, span.status), (Some(3), 1));
    for (kind, code) in [
        (json!("SPAN_KIND_SERVER"), json!(0)),
        (json!(1), json!(1.5)),
        (json!(4294967296u64), json!(0)),
    ] {
        let export = traces(
            json!([]),
            json!({ "traceId": TRACE, "spanId": SPAN, "kind": kind, "status": { "code": code } }),
        );
        assert!(
            decode_spans(&export).is_err(),
            "kind {kind}, code {code} should be refused"
        );
    }
}

/// Before an index replaced the scan, 128,000 entries in one key-value list took about 20 s to
/// decode; now it is about a tenth of a second. 10 s leaves room for a slow machine or a debug
/// build without letting the quadratic version through.
#[test]
fn a_large_key_value_list_decodes_in_linear_time() {
    let entries: Vec<Value> = (0..128_000)
        .map(|index| json!({ "key": format!("k{index:06}"), "value": { "stringValue": "v" } }))
        .collect();
    let export = traces(
        json!([]),
        json!({ "traceId": TRACE, "spanId": SPAN, "attributes": [{ "key": "big", "value": { "kvlistValue": { "values": entries } } }] }),
    );
    let started = std::time::Instant::now();
    let decoded = decode_spans(&export).expect("decodes");
    let took = started.elapsed();
    assert!(
        took < std::time::Duration::from_secs(10),
        "decoding took {took:?}"
    );
    let stored: Value =
        serde_json::from_str(&decoded.groups[0].1[0].attributes_json).expect("JSON");
    let big: serde_json::Map<String, Value> =
        serde_json::from_str(stored["big"].as_str().expect("text")).expect("JSON object");
    assert_eq!(big.len(), 128_000);
}

#[test]
fn a_key_value_list_keeps_first_positions_and_last_values_across_many_repeats() {
    let mut entries = Vec::new();
    for round in 0..3 {
        for key in ["c", "a", "b"] {
            entries.push(json!({ "key": key, "value": { "intValue": format!("{round}") } }));
        }
    }
    entries.push(json!({ "key": "d", "value": { "stringValue": "new" } }));
    assert_eq!(
        value(json!({ "kvlistValue": { "values": entries } })),
        json!(r#"{"c":2,"a":2,"b":2,"d":"new"}"#)
    );
}

#[test]
fn deeply_nested_arrays_stringify_like_flat_ones() {
    let mut nested = json!({ "stringValue": "x" });
    // Each level is three levels of JSON; serde_json stops at 128, so about 40 fit in an export.
    for _ in 0..30 {
        nested = json!({ "arrayValue": { "values": [nested, {}, { "stringValue": "" }, { "intValue": "1" }] } });
    }
    let expected = std::iter::once("x")
        .chain(std::iter::repeat_n("1", 30))
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(value(nested), json!(expected));
}

#[test]
fn int_values_keep_every_digit_up_to_the_int64_limits() {
    assert_eq!(
        value(json!({ "intValue": "9223372036854775807" })),
        json!("9223372036854775807")
    );
    assert_eq!(
        value(json!({ "intValue": "-9223372036854775808" })),
        json!("-9223372036854775808")
    );
    // Above 2^53, where Motel's JavaScript number lost the last digits.
    assert_eq!(
        value(json!({ "intValue": "9007199254740993" })),
        json!("9007199254740993")
    );
    let out_of_range = traces(
        json!([]),
        json!({ "traceId": TRACE, "spanId": SPAN, "attributes": [{ "key": "v", "value": { "intValue": "9223372036854775808" } }] }),
    );
    assert!(decode_spans(&out_of_range).is_err());
}

#[test]
fn arrays_join_their_non_empty_values_with_a_space() {
    let array = json!({ "arrayValue": { "values": [{ "stringValue": "a" }, {}, { "intValue": "2" }, { "boolValue": true }, { "stringValue": "" }] } });
    assert_eq!(value(array), json!("a 2 true"));
    let nested = json!({ "arrayValue": { "values": [{ "stringValue": "a" }, { "arrayValue": { "values": [{ "stringValue": "b" }, { "stringValue": "c" }] } }] } });
    assert_eq!(value(nested), json!("a b c"));
    assert_eq!(value(json!({ "arrayValue": {} })), json!(""));
}

#[test]
fn key_value_lists_become_json_in_their_first_order_with_the_last_value() {
    let list = json!({ "kvlistValue": { "values": [
        { "key": "z", "value": { "intValue": "1" } },
        { "key": "a", "value": { "doubleValue": 0.5 } },
        { "key": "z", "value": { "stringValue": "last" } },
        { "key": "none" },
        { "key": "list", "value": { "arrayValue": { "values": [{ "boolValue": false }] } } },
    ] } });
    assert_eq!(
        value(list),
        json!(r#"{"z":"last","a":0.5,"none":null,"list":[false]}"#)
    );
}

#[test]
fn a_repeated_attribute_keeps_its_last_value_and_keys_are_sorted() {
    let span = one_span(json!({ "traceId": TRACE, "spanId": SPAN, "attributes": [
        { "key": "b", "value": { "stringValue": "1" } },
        { "key": "a", "value": { "stringValue": "2" } },
        { "key": "b", "value": { "stringValue": "3" } },
    ] }));
    assert_eq!(span.attributes_json, r#"{"a":"2","b":"3"}"#);
}

#[test]
fn span_fields_map_as_motel_mapped_them() {
    let span = one_span(json!({
        "traceId": TRACE, "spanId": SPAN, "name": "op", "kind": 3,
        "startTimeUnixNano": "1700000000123456789", "endTimeUnixNano": 1700000000223456789u64,
        "status": { "code": 2, "message": "dropped" },
        "events": [{ "name": "e", "timeUnixNano": "5", "attributes": [{ "key": "k", "value": { "stringValue": "v" } }] }, {}],
    }));
    assert_eq!(span.name, "op");
    assert_eq!(span.kind, Some(3));
    assert_eq!(span.start_ns, 1_700_000_000_123_456_789);
    assert_eq!(span.end_ns, 1_700_000_000_223_456_789);
    assert_eq!(span.status, 1);
    assert_eq!(span.scope_name.as_deref(), Some("scope"));
    assert_eq!(
        span.events_json.as_deref(),
        Some(
            r#"[{"name":"e","timeNs":5,"attributes":{"k":"v"}},{"name":"event","timeNs":0,"attributes":{}}]"#
        )
    );

    let bare =
        one_span(json!({ "traceId": TRACE, "spanId": SPAN, "kind": 9, "status": { "code": 1 } }));
    assert_eq!(bare.name, "unknown");
    assert_eq!(bare.kind, None);
    assert_eq!((bare.start_ns, bare.end_ns, bare.status), (0, 0, 0));
    assert_eq!(bare.events_json, None);
    assert_eq!(bare.attributes_json, "{}");
}

#[test]
fn times_out_of_range_or_not_numbers_make_the_export_invalid() {
    for time in [json!("soon"), json!("-1"), json!("9223372036854775808")] {
        let export = traces(
            json!([]),
            json!({ "traceId": TRACE, "spanId": SPAN, "startTimeUnixNano": time }),
        );
        assert!(decode_spans(&export).is_err(), "{time} should be refused");
    }
}

#[test]
fn the_service_name_falls_back_to_service_name_then_unknown() {
    let service = |resource: Value| {
        let decoded = decode_spans(&traces(
            resource,
            json!({ "traceId": TRACE, "spanId": SPAN }),
        ))
        .expect("decodes");
        decoded.groups[0].0.service_name.clone()
    };
    assert_eq!(
        service(
            json!([{ "key": "service.name", "value": { "stringValue": "a" } }, { "key": "service_name", "value": { "stringValue": "b" } }])
        ),
        "a"
    );
    assert_eq!(
        service(
            json!([{ "key": "service.name", "value": { "stringValue": "" } }, { "key": "service_name", "value": { "stringValue": "b" } }])
        ),
        "b"
    );
    assert_eq!(service(json!([])), "unknown");
}

#[test]
fn resource_attributes_are_canonical_whatever_their_order() {
    let resource = |attributes: Value| {
        let decoded = decode_spans(&traces(
            attributes,
            json!({ "traceId": TRACE, "spanId": SPAN }),
        ))
        .expect("decodes");
        decoded.groups[0].0.attributes_json.clone()
    };
    let a = json!({ "key": "a", "value": { "stringValue": "1" } });
    let b = json!({ "key": "b", "value": { "stringValue": "2" } });
    assert_eq!(resource(json!([a, b])), resource(json!([b, a])));
}

#[test]
fn a_log_takes_its_ids_from_attributes_first_then_the_record() {
    let other = "11111111111111111111111111111111";
    let log = one_log(
        json!({ "traceId": other, "spanId": "2222222222222222", "attributes": [
        { "key": "trace_id", "value": { "stringValue": TRACE } },
        { "key": "spanId", "value": { "stringValue": SPAN } },
    ] }),
    );
    assert_eq!(
        (log.trace_id, log.span_id),
        (Some(trace_bytes()), Some(span_bytes()))
    );
    let camel_first = one_log(json!({ "attributes": [
        { "key": "trace_id", "value": { "stringValue": other } },
        { "key": "traceId", "value": { "stringValue": TRACE } },
    ] }));
    assert_eq!(camel_first.trace_id, Some(trace_bytes()));
    let from_record = one_log(json!({ "traceId": TRACE, "spanId": SPAN }));
    assert_eq!(
        (from_record.trace_id, from_record.span_id),
        (Some(trace_bytes()), Some(span_bytes()))
    );
}

#[test]
fn a_log_id_that_cannot_be_read_is_dropped_not_refused() {
    let log =
        one_log(json!({ "traceId": "not-an-id", "spanId": "", "body": { "stringValue": "kept" } }));
    assert_eq!((log.trace_id, log.span_id), (None, None));
    assert_eq!(log.body, "kept");
}

#[test]
fn log_fields_map_as_motel_mapped_them() {
    let log = one_log(
        json!({ "observedTimeUnixNano": "7", "body": { "kvlistValue": { "values": [{ "key": "m", "value": { "stringValue": "x" } }] } } }),
    );
    assert_eq!(log.time_ns, 7);
    assert_eq!(log.severity_text, "INFO");
    assert_eq!(log.body, r#"{"m":"x"}"#);
    assert_eq!(log.scope_name, None);
    let timed = one_log(
        json!({ "timeUnixNano": "5", "observedTimeUnixNano": "7", "severityText": "WARN" }),
    );
    assert_eq!((timed.time_ns, timed.severity_text.as_str()), (5, "WARN"));
}

#[test]
fn exports_that_are_not_otlp_json_are_invalid() {
    assert!(decode_spans(b"{not json").is_err());
    assert!(decode_spans(br#"{"resourceSpans": 3}"#).is_err());
    assert!(decode_spans(br#"{"resourceSpans": [{"scopeSpans": [{"spans": [{"spanId": "b7ad6b7169203331"}]}]}]}"#).is_err());
    assert_eq!(
        decode_spans(b"{}")
            .expect("an empty export is valid")
            .groups
            .len(),
        0
    );
    assert!(decode_logs(br#"{"resourceLogs": [{"scopeLogs": [{"logRecords": [{"body": {"intValue": "x"}}]}]}]}"#).is_err());
}
