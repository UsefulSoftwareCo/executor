# executor-collector

The telemetry collector bundled with Executor, in Rust. It takes OTLP/HTTP JSON traces and logs
and keeps them in one SQLite file. It is not wired into the product yet: Motel
(`packages/telemetry/motel`) is still the collector every host runs.

## Build

```sh
cargo build --release --locked
cargo fmt --check
cargo clippy --release --locked --all-targets -- -D warnings
cargo test --release --locked
```

The tests in `tests/` are the narrow exception to the repository's E2E-only rule described in
`AGENTS.md`. `otlp_mapping.rs`, `store.rs` and `lifecycle.rs` test the field mapping, the store and
the shutdown drain through the library. `process.rs` runs the built binary: stop signals, its
socket, acknowledging only stored exports, gzip bodies, deep nesting at the size limit, an
interrupted first start and resident memory after a burst (Linux with glibc only).
CI runs them in the `collector-native` job when the crate changes.

`rust-toolchain.toml` pins the toolchain. Every dependency is pinned to an exact version in
`Cargo.toml` and `Cargo.lock`.

## Run

```sh
executor-collector serve --data <dir> [--listen 127.0.0.1:0 | --listen unix:<path>]
    [--max-pending 4] [--max-export-bytes 16777216]
```

Once it is listening it prints one line on stdout, `{"event":"listening","port":N}` for TCP or
`{"event":"listening","path":P}` for a Unix socket, and nothing else. Its own log is JSON lines on
stderr.

SIGTERM or SIGINT (Ctrl-C or Ctrl-Break on Windows) stops it within 2.5 seconds, inside the local
host's 3-second kill. It listens for them before it prints the listening line. On a stop signal:

- It stops accepting and gives open requests 1.5 seconds.
- The writer finishes the export it is storing. Exports still queued are abandoned: they were
  never acknowledged, so their senders resend them.
- It saves the refusal counts and closes the store.
- If the store has not closed by the deadline, the process exits anyway. SQLite discards a
  transaction it had not committed.

No statement waits more than 500 ms for a lock held by another process.

At a `unix:` path, binding fails when anything already exists there, a stale socket file
included, and the collector exits 1 naming the path. It never removes a path it did not create.
Whatever supervises it owns the directory and removes a socket file an earlier run left behind, as
the self-host Go host does before each start. On exit the collector removes its own socket. It
first checks that the path is still that socket (device and inode), which protects against a
replacement made earlier. The check and the removal are two steps, so this holds only while nothing
else replaces files in that directory. The supervisor's private directory, with one collector at a
time, guarantees that.

It exits with code 1, before printing the listening line, when it cannot open or create the store
or cannot listen.

## Routes

| Route             | Answer                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/traces` | `{insertedSpans}`: every span of the export, including resent spans that were already stored                                                                 |
| `POST /v1/logs`   | `{insertedLogs}`                                                                                                                                             |
| `GET /api/health` | `{ok, service, version}`                                                                                                                                     |
| `GET /api/ingest` | `{pending, maxPending, maxBytes, refused: {queueFull, tooLarge, invalid, storeFailed, overBound}, refusedBytes, lastRefusedAt, evictions: {passes, traces}}` |

Anything else answers 404 `{error}`. Query routes, retention and the viewer come in later changes.

### Admission

Bodies may be uncompressed or gzip (`Content-Encoding: gzip`), which every OTLP/HTTP server must
accept. The size limit holds after decompression too.

An export takes one of `--max-pending` permits before its body is read and holds it until it is
stored, even if the sender hangs up, so at most that many bodies of at most `--max-export-bytes`,
with their decoded rows, are in memory at once.

| Export                                                        | Status                 | Counted as    |
| ------------------------------------------------------------- | ---------------------- | ------------- |
| `Content-Length` over the limit, or a body that grows past it | 413                    | `tooLarge`    |
| `application/x-protobuf` or `application/protobuf`            | 415                    | `invalid`     |
| A gzip body over the limit once decompressed                  | 413                    | `tooLarge`    |
| `Content-Encoding` other than `gzip` or `identity`            | 415                    | `invalid`     |
| No permit free                                                | 429, `Retry-After: 1`  | `queueFull`   |
| Not OTLP JSON, or a span with an invalid id                   | 400                    | `invalid`     |
| The store failed                                              | 500                    | `storeFailed` |
| The collector is stopping                                     | 503, `Retry-After: 10` | `storeFailed` |

`refusedBytes` adds the declared `Content-Length` of each refused export. Without one, it adds
the bytes read before the refusal, which is none for a refusal before the body is read. The counts
are kept in the store and survive a restart. A storage failure is logged every time;
other refusals at most once a minute.

### Field mapping

The mapping follows what Motel stored, so the same exports read back the same way:

- Attribute values are stored as strings: arrays joined with a space, key-value lists as JSON,
  bytes as base64. `intValue` keeps all its digits. `doubleValue` may be a number or a ProtoJSON
  string: `"NaN"`, `"Infinity"`, `"-Infinity"` or a quoted number.
- Values may nest to any depth the size limit allows. Inside up to 64 arrays and key-value lists
  they are stored as Motel stored them. A value inside more is kept as its `AnyValue`'s JSON text,
  exactly as the export spelled it, where its value would have been: in an array it is joined
  with a space, in a key-value list it is a JSON string. Decoding uses at most about 91 KiB of
  stack in a release build (544 KiB in a debug build) of the 2 MiB the collector gives each
  decoding thread, whatever `RUST_MIN_STACK` is set to, and stays linear in the export's size. Unknown fields are skipped at any depth. Nesting where
  OTLP has no nested value, such as `"resourceSpans": [[[...`, still meets serde_json's
  128-level limit and is refused with 400.
- Integer fields (`intValue`, every `*TimeUnixNano`, `kind` and `status.code`) take any ProtoJSON
  integer form: a JSON number or a string, with or without an exponent or a fraction part, as long
  as the value is whole and in the field's range (`1e2`, `"1e2"`, `"100.0"`, `1.7e18`). Strings
  are read exactly, however long their digits and exponent; numbers with an exponent or fraction are read as doubles. A missing or empty
  timestamp is 0, as in Motel.
- Span ids are hex of the right length, in either case, or canonical base64; the product sends
  hex, and the e2e harness's sharded collector reads both. A span with any other id makes its
  export invalid (Motel stored it as given).
- A log's trace and span ids come from its `traceId`/`trace_id` and `spanId`/`span_id`
  attributes first, then from the record. An id that cannot be read is dropped from the log.
- A log's time is `timeUnixNano`, or `observedTimeUnixNano` when that is missing or zero.

## Store

`<data>/telemetry.sqlite`, in WAL mode with incremental auto-vacuum. The format is in
`PRAGMA user_version`. The collector creates the file when it is new, and checks an existing file's
tables against the format before it listens. It refuses a store of an older or newer format, and
leaves it as it is.

- A span sent again unchanged is counted and not written. A changed span replaces the stored one.
- A trace's `last_seen_ms` is when a span of it was last written; an unchanged resend leaves it.
- Resources are stored once and kept exactly while a span or log refers to them.

The schema's notes in `src/store.rs` give the measurements behind the table layout.

## Memory

glibc's allocator kept most of a burst of exports resident. The collector caps glibc at one
malloc arena. Each export, stored or refused, ends by asking the writer to return memory. Once
250 ms have passed with no export finishing, the writer releases SQLite's page cache and calls
`malloc_trim`.

In the memory scenario's burst (`e2e/tests/docker-release-collector-memory.spec.ts`: 4 exports of
12,000 spans), it gives back about 98% of what the burst used within half a second.
