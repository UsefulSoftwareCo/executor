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
the shutdown drain through the library. `retention.rs` tests age and size eviction, the step
bound with a very large trace and the store format policy through the library. `process.rs` runs
the built binary: stop signals, its socket, acknowledging only stored exports, gzip bodies, deep
nesting at the size limit, an interrupted first start, a drain killed part way, a store of another
format, the write-ahead log's bound under load and resident memory after a burst (Linux with
glibc only).
CI runs them in the `collector-native` job when the crate, its build script or its CI actions
change; that job also builds, checks and smoke-tests the linux-x64 release executable.

`rust-toolchain.toml` pins the toolchain. Every dependency is pinned to an exact version in
`Cargo.toml` and `Cargo.lock`.

### Release builds

`packages/telemetry/scripts/build-collector.ts` builds the executable that ships, for one release
target, and is the only way it should be built for packaging (`bun run collector:build` builds for
this machine). It needs rustup, which installs the pinned toolchain and the target's standard
library itself.

```sh
node packages/telemetry/scripts/build-collector.ts [--target <target>] build check smoke
node packages/telemetry/scripts/build-collector.ts [--target <target>] --key
```

| Target         | Rust target                 | Built on               | Floor                    |
| -------------- | --------------------------- | ---------------------- | ------------------------ |
| `linux-x64`    | `x86_64-unknown-linux-gnu`  | Linux x64              | glibc symbols up to 2.35 |
| `linux-arm64`  | `aarch64-unknown-linux-gnu` | Linux arm64            | glibc symbols up to 2.35 |
| `darwin-arm64` | `aarch64-apple-darwin`      | macOS on Apple Silicon | macOS 11.0               |
| `darwin-x64`   | `x86_64-apple-darwin`       | macOS on Apple Silicon | macOS 10.15              |
| `win32-x64`    | `x86_64-pc-windows-msvc`    | Windows x64            | static C runtime         |

- `build` writes `packages/telemetry/dist/collector/`: the executable, `NOTICE` (Motel's licence),
  `licenses/` (the licence files of every crate linked into the executable, and the Rust standard
  library's `COPYRIGHT-library.html`), `cargo-packages.txt` (those crates as `name@version`) and
  `identity`. It does nothing when `identity` already holds the current key. Path prefixes from
  the build machine are remapped, Windows links the C runtime statically, and macOS builds set
  `MACOSX_DEPLOYMENT_TARGET`. Every Rust and C tool runs with the pinned toolchain named in
  `RUSTUP_TOOLCHAIN`, which outranks a `rustup override`, and with only the variables that find
  the tools (`PATH`, the homes, the Windows system directories): `CC`, `CFLAGS`, `RUSTFLAGS`,
  `CARGO_*` other than `CARGO_HOME`, `LIBSQLITE3_FLAGS` and every other variable are dropped.
  Each crate linked into the executable must have at least one primary licence file (its declared
  `license_file`, or a top-level `LICENSE*`, `LICENCE*`, `COPYING*` or `UNLICENSE*`); a `NOTICE`,
  `COPYRIGHT` or third-party file is copied beside it but never counts as one. This proves a
  licence file is present, not that the files cover every licence in the crate's SPDX
  expression.
- `check` fails when the executable is not the target's architecture, is over 15 MiB, contains a
  build machine path, or exceeds its floor: on Linux, a glibc symbol newer than 2.35 or a shared
  library other than libc, libm, libgcc_s and the loader; on macOS, a different `minos` or a
  library outside `/usr/lib` and `/System/Library`; on Windows, an import of the C runtime DLLs or
  an embedded manifest without `longPathAware`. `build.rs` embeds `windows.manifest`: bundled
  SQLite opens files with plain Win32 paths, so without it a store path over 260 characters fails
  even where the machine allows long paths (found by the first Windows smoke test).
- `smoke` checks the 15 MiB cap too, then starts the executable on a temporary port with a store
  path over 260 characters, checks `GET /api/health`, stores one span, one log and a span whose
  attribute sits inside 64 key-value lists (decoding runs on the collector's own thread stack,
  measured only on x86-64 Linux), checks `GET /api/ingest`, stops it and starts it again on the
  same store. When the test fails or ends, every collector it started is killed and waited for, up
  to 5 seconds each, and its directory removed; a SIGKILL of the test's own Node process skips
  that. It needs neither git nor Rust. On Windows it can only terminate the process, so
  the stop on Ctrl-Break is not exercised there.
- `--key` installs the pinned toolchain if needed and prints the artifact identity: a SHA-256 of
  the crate's files (tracked, or untracked and not ignored), the build script, the target, the
  Rust toolchain's `rustc -vV` and `cargo -vV`, and the C compiler and linker that environment
  finds.

The identity's promise is for a clean environment: no Cargo config file anywhere Cargo would read
one (`config.toml` or `config` in `.cargo` in the crate's directory or any directory above it,
or in Cargo's home). That is every CI and release runner. Cargo's home is `CARGO_HOME` when it is
set and not empty, otherwise `.cargo` in the home directory, and the script gives every tool it
runs that same absolute path; a relative `CARGO_HOME` is refused. Anything at a config path that
is not a regular file (a directory, a link to one, a link to nothing) is an error. That is this
script's own rule, deliberately stricter than Cargo, which ignores a link to nothing: no key is
made while anything but a readable config file sits at a config path. In such an environment two
builds with the same identity have produced the same bytes in every case tested, and `build`
skips a build whose `identity` already matches. If any Cargo config file is in effect, `build`
says which in one line, runs cargo without that shortcut (cargo makes its own up-to-date decision), and writes an
identity that no key can equal; `--key` fails, and `.github/actions/collector` treats that as an
error.

## Run

```sh
executor-collector serve --data <dir> [--listen 127.0.0.1:0 | --listen unix:<path>]
    [--max-pending 4] [--max-export-bytes 16777216] [--retention-hours 168] [--max-store-mb 1024]
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

No statement waits more than 500 ms for a lock held by another process, but for SQLite's own
retries while a read starts, which a process outside the collector holding the store's locks can
stretch to about 10 s (see Fields and markers).

`--max-export-bytes` may be from 65,536 (64 KiB) to 134,217,728 (128 MiB); anything else exits 2
saying so. The store records the largest limit it has been started with (at the start, before any row is
admitted). A start with a smaller
one empties the store in place before it serves, in one transaction, and logs `emptied the
telemetry store: it has been started with a larger --max-export-bytes` with both limits: a
row stored under the larger limit could hold more text than a reader of the smaller one may read
(four times the limit; see Memory ceilings), so no row is kept that a reader could not answer
whole. A start with the same or a larger limit keeps every row.

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

| Route             | Answer                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/traces` | `{insertedSpans}`: every span of the export, including resent spans that were already stored                                                                                            |
| `POST /v1/logs`   | `{insertedLogs}`                                                                                                                                                                        |
| `GET /api/health` | `{ok, service, version}`                                                                                                                                                                |
| `GET /api/ingest` | `{pending, maxPending, maxBytes, refused: {queueFull, tooLarge, invalid, storeFailed, overBound}, refusedBytes, lastRefusedAt, evictions: {passes, traces, spans, logs}, store: {...}}` |

Anything else answers 404 `{error}`. The viewer's files are served by a later change.

`/api/ingest` also has `droppedEvents`: span events not stored because their span had more than
128 (see Field mapping), in exports that were stored, kept with the refusal counts. And
`readers: {max, busy, refusedBusy, refusedGate, cutOff, yielded}`: the
readers, how many are answering now, and how many queries were refused for want of one or because
the read gate stayed closed, cut off at their deadline, or gave way to the gate (see Readers).

`/api/ingest`'s `store` object lets a caller tell, without waiting a fixed time, how large the
store is and whether retention has finished:

| Field                 | Meaning                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `usedBytes`           | Bytes of pages holding data: what `--max-store-mb` bounds                                                                                                                                        |
| `fileBytes`           | The database file: pages in use and free pages                                                                                                                                                   |
| `walBytes`            | The write-ahead log file                                                                                                                                                                         |
| `maxBytes`            | The bound, `--max-store-mb` in bytes                                                                                                                                                             |
| `retentionHours`      | `--retention-hours`                                                                                                                                                                              |
| `draining`            | Over the bound and evicting down to 90% of it                                                                                                                                                    |
| `maintenancePending`  | Retention has eviction or free pages left to do; `false` once a drain has finished. Set before an export that causes work is acknowledged, so the first status read after a 200 already shows it |
| `walFull`             | The log is over `walRefuseBytes` and exports are refused until it is emptied                                                                                                                     |
| `walRefuseBytes`      | The log size past which exports are refused: a sixteenth of the bound, at least 32 MiB                                                                                                           |
| `gateClosed`          | New reads are held at the read gate while the writer empties the log                                                                                                                             |
| `gateClosings`        | Times the read gate was closed since the collector started                                                                                                                                       |
| `walEmptied`          | Checkpoints that emptied the log since the collector started                                                                                                                                     |
| `checkpointsBlocked`  | Checkpoints that could not empty the log because a reader was using it                                                                                                                           |
| `steps`               | Retention steps run since the collector started                                                                                                                                                  |
| `longestStepMs`       | The longest one retention step held the writer                                                                                                                                                   |
| `longestExportWaitMs` | The longest one export waited in the queue while retention ran                                                                                                                                   |

`evictions.passes` counts periods of eviction that removed at least one trace, `traces`, `spans`
and `logs` what they removed, all since the collector started. A pass is counted when its first
trace is gone, so a trace the caller sees missing means `passes` already counts its pass.

### Admission

Bodies may be uncompressed or gzip (`Content-Encoding: gzip`), which every OTLP/HTTP server must
accept. The size limit holds after decompression too.

An export takes one of `--max-pending` permits before its body is read and holds it until it is
stored, even if the sender hangs up, so at most that many bodies of at most `--max-export-bytes`,
with their decoded rows, are in memory at once.

A name is at most 4,096 bytes (`otlp::NAME_BYTES`): a span's, an event's and a scope's name, an
attribute's key (inside key-value lists too), the `service.name` value and `severityText`. An
export with a longer one is refused with 400 (`invalid`), its message naming the field and the
length, checked before the name is copied; a name spelled with escapes is unescaped first,
into a copy that is charged, as every unescaped string is. The limit applies to every name and key the collector decodes and keeps. Content past depth 64
(`VALUE_DEPTH`) is kept as raw text and counted as a value; events after the 128th are dropped
unread. Neither is checked. Every value the collector decodes has its nested keys checked, whether or not a later value for the same key replaces it; for `service.name`, the value checked is the one kept (the last). Raw text is bounded by the row limit,
and neither it nor a dropped event ever becomes a key, a name in a list, a header, an index
entry or a summary.

Decoding an export may hold at most eight times `--max-export-bytes` (`otlp::DECODE_SHARE`), and
one row's text at most four times it (`otlp::ROW_SHARE`: escaping can make a value about three
times longer than the export spelled it, for a value kept as its JSON text inside a key-value
list). What decoding builds whose size depends on the export is charged before it is allocated,
at the size glibc's allocator will take for it: lists and the key table grow only by a charged
reservation, a long list in chunks of 64 KiB (never copied as it grows), the rows for exactly as
many items as the export's lists hold, strings are allocated once at a length worked out first,
strings are borrowed from the export unless they need unescaping, what serde_json keeps to skip a
nested value (a byte for each open bracket) is charged from the export's deepest nesting, and what is freed while decoding is given back. An export
past either limit is refused with 413 (`tooLarge`), before it holds more. `tests/memory.rs` counts
every allocation for a corpus of export shapes and checks that decoding holds no more than its
charge and serde_json's scratch: exports shaped like the product's are charged about 2.2 to 2.9
times their size; ones made of nothing but empty events, empty logs or a scope name copied into
every row are refused well under the size limit. At the default 16 MiB, 262,145 short INFO logs
(13.6 MB) are stored, charged 119.6 MB and holding 86 MB while decoding; 524,289 empty logs
(1.6 MB) and 200,000 logs under a 256-byte scope name (6.6 MB) are refused with 413.

| Export                                                        | Status                 | Counted as    |
| ------------------------------------------------------------- | ---------------------- | ------------- |
| `Content-Length` over the limit, or a body that grows past it | 413                    | `tooLarge`    |
| `application/x-protobuf` or `application/protobuf`            | 415                    | `invalid`     |
| A gzip body over the limit once decompressed                  | 413                    | `tooLarge`    |
| Decoding over its budget, or a row larger than the limit      | 413                    | `tooLarge`    |
| Writing more to disk than one export may (below)              | 413                    | `tooMuchDisk` |
| `Content-Encoding` other than `gzip` or `identity`            | 415                    | `invalid`     |
| No permit free                                                | 429, `Retry-After: 1`  | `queueFull`   |
| Not OTLP JSON, a span with an invalid id, or a name too long  | 400                    | `invalid`     |
| The store failed                                              | 500                    | `storeFailed` |
| The collector is stopping                                     | 503, `Retry-After: 10` | `storeFailed` |
| Data over 110% of the bound, or the write-ahead log full      | 429, `Retry-After: 1`  | `overBound`   |

Every refusal a sender can retry is answered so that OTLP exporters retry it: 429 with
`Retry-After`, 500, or 503 with `Retry-After`. The log line for an `overBound` refusal says which
case it is, the store over its bound or the log full, and carries `/api/ingest`'s figures.

A refusal made before the body is read closes the connection with the body unread, so a sender
still writing it may see the connection reset instead of the 429. OTLP exporters, the product's
included, retry a lost connection as they retry a 429.

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
- A span keeps its first 128 events (`otlp::EVENT_LIMIT`). The rest are dropped unread (their
  names are not checked; see Admission), and counted: the span's `warnings` say how many were dropped, and
  `/api/ingest`'s `droppedEvents` adds them up. Motel kept every event. The product's spans have
  at most one.

## Store

`<data>/telemetry.sqlite`, in WAL mode with incremental auto-vacuum. The format is in
`PRAGMA user_version` and the file is marked as a telemetry store by `PRAGMA application_id`
(`0x45585443`).

**What the collector owns.** `--data` is resolved once, so it may be a link to a directory, end in
a slash, be relative or be `.`. In it the collector uses `telemetry.sqlite`, the files SQLite
manages beside it (`telemetry.sqlite-wal`, `-shm` and `-journal`), and `telemetry.lock`. The
collector's own code removes none of the store's files. SQLite itself creates, truncates and
removes `-journal`, `-wal` and `-shm` for a store of ours as it opens, recovers, checkpoints and
closes it. (A Unix socket the collector created is removed when it stops, wherever it is; see
Run.) If any of the four store names is a symbolic link or is not a regular file, the collector
exits 1 and changes nothing; that check is what the tests exercise, and SQLite is also told not to
follow a link at the database's name. A regular file that is a hard link to a file elsewhere is
used as it is, and written through.

**One collector per directory.** Before reading anything else, the collector creates
`telemetry.lock` if it is missing and takes an exclusive advisory lock on it, held until it exits.
A second collector on the same directory exits 1 saying another collector is using it, and changes
nothing, the lock file's contents and times included. The lock is respected by other collectors
only: a SQLite tool can still open the store. The lock file is never removed. Only Linux was run.

**What the file is**, decided from its first bytes with plain file reads, before SQLite opens it
(SQLite recovers, checkpoints and deletes companions as it opens and closes a file):

- Missing or empty: a new store. So is a file of at most one page that never held a table and has
  no application id or format, in rollback mode with no `-wal` beside it: what a first start cut
  off just after its first write leaves (SQLite writes the auto-vacuum setting before the
  application id can be set). Such a file holds no data, but another program may have made it: an
  empty database created at exactly this name, for example with `PRAGMA auto_vacuum = 2`, is
  taken over as a new store.
- Not SQLite, or SQLite with another application id: not ours. The collector exits 1, and every
  file in the directory, `-wal`, `-shm` and `-journal` included, is left byte for byte as it was,
  modification times too; the start's only change is creating `telemetry.lock` if it was missing.
  A store from before format 2 has no application id and is not ours.
- SQLite with this collector's application id: opened with SQLite, which first recovers it if a
  start was cut off, and decided again from what recovery leaves.

**A new store** is created in this order, each step durable before the next: incremental
auto-vacuum, the application id (in rollback mode), WAL mode, then the tables and the format in one
transaction. Creation is re-entrant: a store with no tables of the collector's, after SQLite's
recovery, is finished from whichever step it reached, the application id set if it is missing. A
start cut off at any point, including while writing the application id with its journal still
beside it, leaves a file the next start finishes.

**A store of ours in another format**, or whose tables do not match its format, is emptied in place:
one immediate transaction reads the format again, drops every table, index, trigger and view of the
collector's, creates this format's tables, sets the format and checks the result. It commits or
does nothing: before it commits nothing of the old store is lost, after it the store is this
format's and empty; a result that does not check, or a statement that fails, rolls everything back
and fails the start. SQLite's own tables (`sqlite_stat1` after an `ANALYZE`, `sqlite_sequence`) are
not part of the collector's schema: they neither make a store "not match" nor are dropped. The file
stays the same file. One log line says it happened and why. Free pages go back to the file system
as retention returns them. A store of ours that cannot be emptied (for example, one damaged, or
without incremental auto-vacuum, which only rebuilding the file could change) fails the start and
is not emptied; "left as it is" means not reset, not untouched byte for byte, since SQLite may
still recover or checkpoint it and remove its companions as it closes it. Such a store fails every
start the supervisor retries until someone acts.

**Nothing is served that the next start would refuse.** Before the listening line, on the
connection that serves, the store must carry this collector's application id, format and schema in
WAL mode, and retention's first look at it (its work and figures) must succeed. Otherwise the start
exits 1.

**Failures.** Any I/O or SQLite error during start-up exits 1 and the supervisor retries. Nothing
else is promised.

**A damaged store.** Start-up reads only what it needs, not every page, so damage shows in one of
two ways. Damage to a page start-up reads (the schema, `meta`, the `logs` table, the
`traces_last_seen` index) ends the start: exit 1, no listening line, "database disk image is
malformed" in the log. Damage elsewhere (the `traces` or `spans` table, the `spans_trace_span` or
`logs_time` index) lets the collector start and answer health 200; every export of the signal
whose pages are damaged then fails with 500 (`storeFailed`), logged each time, while the other
signal is stored. Damage to some pages (`resources`, free pages) may not show at all until a write
or a read reaches them. The collector does not repair or empty a damaged store by itself. To
recover: stop the collector, remove `telemetry.sqlite`, `telemetry.sqlite-wal` and
`telemetry.sqlite-shm` from its data directory, and start it again; it creates a new, empty store.

- A span sent again unchanged is counted and not written. A changed span replaces the stored one.
- A trace's `last_seen_ms` is when a span of it was last written; an unchanged resend leaves it.
  `first_seen_ms` is when its first span was.
- Resources are stored once and kept exactly while a span or log refers to them, through ingest
  and through every deletion.

The schema's notes in `src/store.rs` give the measurements behind the table layout.

## Retention

The writer thread runs retention in steps, as its own work between exports. Nothing is queued
behind or in front of exports on the export queue. See `src/retention.rs`.

- **Age.** A trace whose last span was written more than `--retention-hours` ago is evicted, and
  so is a log written that long ago. The ingest clock is used, not the timestamps in the
  telemetry, so a span that never ends or a skewed clock still ages out. Each export
  takes one stamp for all its rows: the host's clock, but at least a millisecond after the stamp
  before it, so stamps rise from one export to the next, traces and logs alike. After the host's
  clock is set back, or set ahead and then corrected, stamps go on a millisecond an export from
  the latest one until the clock passes them, and those rows are kept that much longer; past a
  thousand exports a second they run ahead of the clock by the excess.
  Retention's "now" is `max(host clock, last stamp)`, and a row expires when its stamp is older
  than `--retention-hours` by that "now". So while ingest runs above a thousand exports a second,
  "now" runs ahead of the host's clock and older rows age out in less wall time than
  `--retention-hours`; once ingest is quiet, "now" stands still until the host's clock catches up
  with the last stamp, and rows are kept that much longer. The clock is restored at
  start from the newest stamp still stored: stamps never go back among the rows the store holds,
  but after eviction has removed the newest rows a restart can stamp earlier than those rows had.
- **Size.** When the pages holding data pass `--max-store-mb`, the store drains until they are at
  or below 90% of it. Draining evicts what arrived first, traces and logs alike: the earliest
  trace or the earliest logs, whichever arrived earlier by their stamps, a trace by the export
  that first wrote it. The draining state is kept in the store,
  so a drain continues after a restart. Running traces are evicted like finished ones.
- **Keeping up.** After each export, while there is eviction to do, the writer runs steps until
  they have freed twice what the export added. With no export queued it runs steps until there
  is nothing left. Exports are refused (`overBound`) only when data passes 110% of the bound,
  which means eviction cannot keep up, for example because its steps fail. That 110% is an
  admission threshold on the size the writer settled at after the last export's eviction, not a
  ceiling on the disk at every instant: an export already admitted is stored whatever its size
  (one export took a 1 MiB store to 17 MiB), and eviction then brings the store back down.
- **One step** is one transaction that deletes at most 1,000 spans and logs. A trace is evicted
  whole, over as many steps as it needs: its rowid is kept in the store as the trace being
  evicted until its last span and log are gone, so at most one trace is part deleted at any time,
  a crash leaves it marked, and the next start finishes it. Queries treat it as already gone. A
  span that arrives for it is counted in `insertedSpans` and not written: it belongs to a trace
  being evicted. A trace's logs go with it. A step is bounded in rows, so its time is set by the
  disk: at 1 GiB on an NVMe drive, 14 ms median and 179 ms at most; on a SATA QLC drive under
  sustained flat-out writes, up to 2.5 s, when its checkpoint's `fsync` waited on the drive.
- **Free pages** beyond 10% of the bound go back to the file system, at most 512 pages a step.

### Disk use and the write-ahead log

`--max-store-mb` bounds the data the store keeps. On disk, the data directory also holds free pages
up to 10% of the bound, the write-ahead log and its index. The log is bounded too:

- SQLite's checkpoints, run as transactions commit, copy the log into the database but start the
  log again only when a write begins with every frame copied and no reader holding a snapshot of
  it. Readers that follow one another closely, each short, can always hold one. On 13 Nov 2026 a
  load test of this collector before the bound existed grew the log to 19 GB beside a 64 MB
  database in 215 seconds, with one reader that began a 5-second read as soon as the last one
  ended.
- Past 8 MiB the writer runs a truncating checkpoint, which waits at most 50 ms for readers and
  empties the file, at most every 250 ms.
- When readers keep that checkpoint from emptying the log, the writer closes the read gate: new
  queries wait there (at most 2 s, then 503 with `Retry-After: 1`), and reads already running
  finish within their own 5 s. The writer tries again every 50 ms and opens the gate once the log
  is empty, so readers, who can wait, wait, and exports are not refused.
- Only if the log passes half the size at which exports are refused, where waiting
  for the running reads would refuse exports, do they give way at once (503 with
  `Retry-After: 1`, or the response cut off).
- A reader outside the collector, such as a script reading the file, is not held by the gate: if
  the log is still not emptied 6 s after the gate closed, the gate opens and stays open for 30 s.
- Past a sixteenth of the bound, and at least 32 MiB, exports are refused (`overBound`, `walFull`)
  and retention pauses. The writer still stores exports it had already admitted (at most
  `--max-pending`), and otherwise writes nothing to the log, the refusal counts included, until it
  is emptied; it tries a truncating checkpoint 50 ms after the last attempt ended, and each
  attempt can itself wait up to 50 ms for readers, so with a reader holding the log an attempt
  starts about every 100 ms. A reader that starts then reads only the database, older readers end,
  and the next checkpoint empties the log. With readers outside the collector starting one after
  another, that takes up to two reads; an outside reader that holds one read open stops ingest
  until it ends. Stopping the collector saves the refusal counts once, a few kilobytes of log; a
  collector killed while the log is full loses the counts it had not saved.

**The trade.** A read that takes seconds completes while exports arrive at the product's pace,
and gives way when they arrive as fast as the collector can store them. Measured on rhys-desktop
with a 900 MiB bound (log refusal size 56.25 MiB), four senders, 120 s, and one caller reading a
100,000-span trace (about 25 MB) over and over at a pace that takes about 3 s:

| Share where reads give way | Product's pace: reads whole | Log at most | Flat out: reads whole | Log at most | Export attempts refused |
| -------------------------- | --------------------------- | ----------- | --------------------- | ----------- | ----------------------- |
| a quarter                  | 45 of 45                    | 10.7 MB     | 0 (82 gave way)       | 21.5 MB     | 0                       |
| half (chosen)              | 45 of 45                    | 10.7 MB     | 0 (45 gave way)       | 33.0 MB     | 0                       |
| three quarters             | 45 of 45                    | 11.0 MB     | 3 (28 gave way)       | 48.0 MB     | 0                       |
| all of it                  | 45 of 45                    | 11.0 MB     | 24 (3 gave way)       | 59.3 MB     | 6 (all stored on retry) |

The product's pace is four senders each sending 4 traces of 30 spans a second (480 spans a
second); flat out stored about 24,000 spans a second. Over ten minutes flat out at three
quarters, the log came within 4.4 MB of the refusal size (54.6 of 59.0 MB; no export refused for
the log), too thin a margin for a slower disk. At half, over the same ten minutes: 4,967 exports stored, no export refused for the log, the log at most 46.3 MB (12.7 MB short), every read of the trace gave way (342) and none came whole.
At the product's pace for ten minutes (below a 256 MiB bound), all 218 reads of the trace
completed and no export was refused, the log at most 13.0 MB, under either share. Half is the
share chosen: reads give up only what ingest needs, with room to spare. A caller that reads a
large trace while ingest runs flat out should retry; the incomplete response says so.

**What one export writes** is limited, and the limit is enforced, not predicted: SQLite's page
layout, not what an export was charged to decode, decides what it writes (a 2 KiB record takes a
whole page; an index entry just past 1,002 bytes takes an overflow page; an export that changes one
small row on each of many stored pages grows the log a page per row without growing the database).
While the writer stores an export it measures what the export has added to the database (its page
count, which counts the transaction's own uncommitted pages, against the count when the
transaction began) and to the write-ahead log (the pages SQLite reports writing to it since then, each with its 24-byte
frame header, `SQLITE_DBSTATUS_CACHE_WRITE`), every 64 rows
(`store::GROWTH_CHECK_ROWS`) and once more before it commits, after writing to the log the pages its
page cache still holds (`sqlite3_db_cacheflush`), so that last check sees all the export writes but
the commit's own frame. The log is measured by SQLite's own count, not the `-wal` file's size: the
count is the same on Linux, macOS and Windows, where an open file's size as its directory entry
reports it can lag, and a page written twice counts twice, so it never reads less than the log
grew. The count is restarted for each export, so none comes near its 31-bit wrap. Past 20M for the database or 20M for the log (`store::WriteLimit`, M being
`--max-export-bytes`), the export is rolled back, nothing of it stored, and refused with 413
(`tooMuchDisk`: "Telemetry export takes more disk to store than the collector allows"). Retention's
own writes (eviction, emptying a store) are not counted or refused.

So a stored export adds at most 20M to the database and 20M (and one frame) to the log. A refused
one adds nothing to the database (its pages were never committed), but may leave in the log file
up to 20M plus what one check interval wrote plus what the page cache held unwritten when it was
measured (`WRITER_CACHE_BYTES`, 8 MiB): its frames are not part of the log, the next export writes
over them, and the writer's truncating checkpoint returns the file's space once it passes 8 MiB (at
most every 250 ms, once no reader holds the log). The check costs nothing measurable: storing an
export of 12,000 spans took a median of 28 to 32 ms with and without it, 2,000 logs 3.5 to 3.8 ms.

`tests/memory.rs` stores 19 shapes, each as large as decoding admits, at 1, 4 and 16 MiB, and checks
each grew the database and the log within the limit; no product-shaped or dense batch comes near
it. The most, store / log, measured on a new store:

| Limit  | Limit, each | Most measured: database / log                                                      |
| ------ | ----------- | ---------------------------------------------------------------------------------- |
| 1 MiB  | 20 MiB      | 12.1 MB / 12.2 MB (a resource for each span, each its own 1,010-byte service name) |
| 4 MiB  | 80 MiB      | 48.3 MB / 48.7 MB (the same)                                                       |
| 16 MiB | 320 MiB     | 193.3 MB / 194.5 MB (the same); 262,145-odd short INFO logs, 13.5 MB / 13.6 MB     |

The export that reaches the limit is one that touches many stored pages: at 1 MiB, one export
re-sending every 16th of 96,000 stored spans with a new end (6,000 spans, 1.0 MB) grows the database
by 0.8 MB and the log by 24.7 MB without the limit; with it, it is refused once SQLite has counted
22.6 MB written to the log, having grown the file by 15.5 MB. Service names are stored once, in their own
table, and a trace refers to its service by id; before that a trace held a copy of its service's
name: one 16.7 MB export of 98,876 traces sharing a 4 KiB service name wrote 949 MB, where it now
writes 31.7 MB.

**What the directory can hold.** Exports are refused once data passes 110% of the bound, but those
already admitted (at most `--max-pending`) are stored, and retention removes their excess
afterwards; past the log's refusal size likewise. So the data directory holds at most:

- 110% of the bound in pages in use, and 10% of the bound in free pages;
- the log's refusal size (a sixteenth of the bound, at least 32 MiB);
- for each export admitted when the store or the log filled, at most 20M more in the database and
  20M more in the log, plus, for one refused, one check interval and 8 MiB of page cache in the log;
- the log's index (`-shm`, under a megabyte at these sizes).

At the defaults (1 GiB bound, M = 16 MiB, four exports) that is 1,126 + 102 + 64 MiB, plus four
times 640 MiB and 8 MiB, plus the interval and the index: about 3.8 GiB at most. By the most any
export measured (193 MB and 195 MB), four exports add about 1.6 GB.

Measured on minisforum with a 64 MiB bound, four senders storing as fast as
they could and four readers of the collector's own querying one after another (30 seconds, the
collector capped at 256 MiB a file): 694 exports stored, none refused, 4,310 reads answered and 24
that gave way, the log at most 28.0 MB and the data directory at most 92.9 MB; the gate closed 76
times. Before the gate, the same run stored 308 exports and refused 77 (all stored on a retry).
With a reader outside the collector that began a 5-second read as soon as the last ended, the gate
cannot help: 82 exports stored, 140 refused attempts, 28 exports lost after three retries each,
the directory at most 105.9 MB.

## Queries

The routes the product's tests, the e2e harness and the viewer call, with Motel's response shapes,
limits, clamping and lookback rules (Motel's `domain.ts`, `httpApi.ts`, `httpListPolicy.ts` and
`TelemetryStore.ts` at the revision `packages/telemetry/motel/source.json` pins):

| Route                                   | Parameters                                                                                                 | Answer                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `GET /api/services`                     | none                                                                                                       | `{data: string[]}`: spans or logs, last day |
| `GET /api/traces`                       | `service`, `limit` (20, at most 100), `lookback`, `cursor`                                                 | `{data: TraceSummary[], meta}`              |
| `GET /api/traces/stats`                 | `groupBy`, `agg=count`, `service`, `lookback`, `limit` (20, 100)                                           | `{data: [{group, value, count}]}`           |
| `GET /api/traces/:traceId`              | none                                                                                                       | `{data: Trace}`, or 404 `{error}`           |
| `GET /api/traces/:traceId/spans`        | none                                                                                                       | `{data: SpanWithContext[]}`                 |
| `GET /api/traces/:traceId/logs`         | `limit` (100, at most 500), `lookback`, `cursor`                                                           | `{data: Log[], meta}`                       |
| `GET /api/spans/search`                 | `service`, `traceId`, `operation`, `attr.<key>`, `lookback`, `limit` (100, 500)                            | `{data: SpanWithContext[], meta}`           |
| `GET /api/logs`, `GET /api/logs/search` | `service`, `severity`, `traceId`, `spanId`, `body`, `attr.<key>`, `lookback`, `limit` (100, 500), `cursor` | `{data: Log[], meta}`                       |

`lookback` is `<n>m`, `<n>h` or `<n>d`, 60 minutes when missing or unreadable, at least 1 minute
and at most 7 days however large the number. It applies to a trace's logs too. A `limit` over the
maximum is clamped; one that is not a number answers 400, as Motel's schema did, and so does a
parameter of the route given twice (an `attr.<key>` given twice keeps its last value). `meta` is
`{limit, lookback, returned, truncated, nextCursor}`: `truncated` is true exactly when more rows
exist, and `nextCursor`, given on every page that has rows, continues the list with nothing lost or
repeated when rows share a timestamp.

A cursor is a position in its list's order: a trace list's is the last trace's start and id, a log
list's the last log's time and row id. Each page continues after that position in the list as it is
when the page is asked for. So a trace whose start or service changes between two page requests can
appear on two pages or on none; reading the list again from the start gives the current list (the
viewer shows a repeated row once). Logs never move. A cursor that does not decode, is of the other
kind of list (a trace cursor on a log route), or has a number out of range answers 400 `{error}`; a
well-formed position is taken on any list of its kind, whatever list it came from. An empty
`cursor=` means no cursor.

`operation` and `body` match as Motel's full-text tables did, with SQLite's own `unicode61`
tokenizer rules (tables generated from the bundled SQLite and checked against it for every code
point): the query's words, runs of two or more ASCII letters, digits or `_`, must each start a
token of the text, a word joined by `_` matching its tokens in a row; tokens fold case and drop
diacritics as `unicode61` does, in every script. A word with no token, such as `__`, matches
nothing. A query with no word matches as SQLite's `LIKE '%query%'`, `%` and `_` acting as
wildcards. Matching takes time linear in the text, times the query's words (or its length over 64
for `LIKE`), and checks the deadline, the read gate and the caller every 65,536 steps.
`attr.<key>=<value>` matches the span's or log's own attribute, else its resource's.

### Readers

- Four read-only connections answer queries. A query first waits at the read gate if the writer
  has closed it (at most 2 s, then 503 `{error}` with `Retry-After: 1`), then takes one of four
  reader permits before any work starts; with none free within 1 s it is answered 503 with
  `Retry-After: 1`. `/api/ingest`'s `readers` counts both refusals.
- A permit is held until the query has given its connection back and its response body has left
  the collector, sent or dropped, whichever is later. So at most four responses are in the
  collector's memory at once, however slowly their callers read.
- Each query is one read transaction, so it answers from one snapshot of the store, and its
  response must be sent within 5 s of taking its permit. At the deadline SQLite is interrupted,
  the query's own loops stop (text matching, a trace's tree), and a response still being sent is
  ended: the connection's writes fail past the deadline, which drops whatever was still queued.
  A query that has not started its response answers 503 `{error}`; one that has is cut off, and
  the caller sees the connection end before the response does. So no reader holds the write-ahead
  log for more than 5 s, and no response outlives 5 s.
- A caller that hangs up before the response starts cancels its query at once (SQLite and the
  query's own loops); after, the body cannot be sent and the query stops.
- When the collector stops, new queries are refused, responses still open at the end of the
  requests' grace period are cut off, and the process exits inside the 2.5 s stop whatever a query
  still running is doing.
- While the read gate is closed, reads already running finish within their 5 s, unless the log
  passes the share of its refusal size where waiting would refuse exports; then they give way at
  once (503 with `Retry-After: 1`, or the response cut off). See Disk use and the write-ahead log.
- The trace being evicted is left out of every answer: its detail is 404, and no list, search,
  log, count or service list includes it or its logs.

**Memory.** Every query's working memory has a ceiling, whatever the store holds (the terms are
in Memory ceilings):

- **Its response:** chunks of exactly 64 KiB, cut inside a value when it is larger, at most four
  queued for the HTTP server, whose own buffer holds about 400 KiB more.
- **The row it is writing,** written from its stored text as it is read: attributes merged with
  its resource's in one pass over the two, events turned into Motel's shape one by one, nothing
  decoded into values. A row's text is at most four times `--max-export-bytes`: refused at
  ingest past it, and a store that has been started with a larger limit is emptied when the
  collector starts with a smaller one (see Run).
- **Resources** kept while their text totals 256 KiB; past that, only the current one. Parent
  names are looked up for each span, never kept.
- **A trace's skeleton,** to put its spans in tree order: at most 48 MiB, counted with upper bounds
  of 256 bytes a span and 384 more for each missing parent, which do not depend on the data (names
  are not kept). That holds a tree of about 190,000 spans, or about 75,000 when every parent is
  missing; an ordinary tree takes about 100 bytes a span, an estimate, not a bound. A trace past
  the ceiling is answered with its earliest spans by start time in nanoseconds, then storage
  order, as many as fit (both ways of cutting it keep by that rule), and says so: its `warnings`
  start with a line giving its span count, the trace gains `partial: {spanCount, returned}`, and
  its spans list gains `meta: {truncated: true, returned, spanCount}`. `spanCount` is the trace's
  stored spans and `returned` how many of them the answer holds; the answer's list also holds a
  synthetic parent for each missing parent, so it is longer than `returned` (157,286 entries for
  78,643 spans when every parent is missing). A trace under the ceiling is answered whole, and
  has neither field.
- Lists hold one row at a time.

Measured:

- four slow callers of a 700,000-span trace, as a chain and as orphans each with its own missing
  parent: resident memory at most 159 MB above where it started (before the ceiling, the orphans
  took the collector to 1,017 MiB);
- four slow callers of a list of 32 spans each with its own 1 MiB resource, each reading 16 MiB of
  its 33 MB answer and then stopping: from 7.1 MB to at most 26.9 MB, and 8.6 MB a second after
  they were cut off (before the bound, 22.9 MB to 169 MB);
- four slow callers of a trace's spans whose 31 names are 1 MiB each: at most 12 MB more (with a
  cache of names, 153 MB).

When a response ends the writer is asked to return freed memory, as after an export (see Memory).

**Fairness.** The deadline bounds each response's hold on a reader, and its memory; it does not
share the readers out. Slow callers that keep coming back can take all four again every five
seconds, and other queries are told to retry (503, `Retry-After: 1`) for as long as that lasts. A
read while ingest runs flat out is not guaranteed to complete either (see Disk use and the
write-ahead log).

### Fields and markers beyond Motel's answers

What a viewer must show that Motel's answers never held, exactly as the collector writes it.

**A trace answered in part** (its ordering would take more than `SKELETON_BYTES`):

- `GET /api/traces/:traceId`: the trace item gains `partial: {spanCount, returned}`, the trace's
  stored spans and how many of them the answer holds (synthetic parents are not counted), and its
  `warnings` start with `the trace has <spanCount> spans; this answer holds the first <returned>
by start time, as many as one answer may hold`. `spans` holds the earliest spans by start time,
  in tree order, with a synthetic parent for each missing parent. `spanCount` keeps Motel's
  meaning, the length of `spans`.
- `GET /api/traces/:traceId/spans`: the answer gains `meta: {truncated: true, returned,
spanCount}`, as above.
- Both fields are absent from a trace answered whole. The trace item's other fields are Motel's,
  in the same (sorted) order.

**A span that kept its first 128 events**: its `warnings` include `<n> events dropped: a span
keeps its first 128`, after any other warning, on every route that answers spans.

**A store that is busy**: a query that finds the store locked, before its answer has started,
answers 503 with `Retry-After: 1` and `{"error":"The store is busy; retry shortly"}`, counted as
`storeBusy` in the query figures; after its answer has started, the answer ends short. Only a
process outside the collector holding the store's locks causes it (the collector's own
checkpoints hold them for moments), and such a process can make an answer take up to about 10 s
before its 503. A fault in the store is still 500.

**A refused export**: its `{error}` gives, in order, where (`Invalid <signal> export at line <l>
column <c>`), then the field and what was expected, then at most 24 characters of the offending
value and `... (<n> bytes)` when it was longer. A name too long says which, as `A span's name is
<n> bytes; a name may be at most 4096`. A message is at most 256 bytes, in valid UTF-8.

### Differences from Motel

Each was found by comparing the two with the same exports and queries (`collector-diff`, kept
outside the repository, with the reviewers' extended corpus) or by reading Motel, and each is either
deliberate or does not reach any caller:

- **Integers keep every digit.** An `intValue` above 2^53 is stored as sent; Motel rounded it to
  a double. So `attr.<key>=<value>` matches such a value exactly, where Motel matched the rounded
  one.
- **A trace's root and service.** A trace's summary (the trace list, its `service` filter, and
  stats by operation or service) names its earliest root span and that span's service, and until
  a root arrives its earliest span, as Motel's trace detail did. Motel's list took the root whose
  name sorts first, and its service: a trace with two roots in two services could be listed under
  the other service, and a trace without a root under the alphabetically smallest operation.
- **Order among equal times.** Rows are ordered by time in nanoseconds; Motel stored
  milliseconds. Spans found by `/api/spans/search` that start in the same millisecond, and
  siblings in a trace that start in the same millisecond, can come in another order; Motel's
  order among them was whatever its query plan gave. Traces that start in the same millisecond
  are listed by their start in nanoseconds, then by trace id descending; Motel broke the
  millisecond tie by trace id. Logs in the same millisecond likewise come by their time in
  nanoseconds, then their id; Motel's by id alone. Stats break ties in count by group name, so where more groups tie than
  `limit` keeps, the groups kept can differ.
- **Very large traces.** A trace whose ordering would take more than 48 MiB is answered with its
  first spans by start time, with a warning, a `partial` object on the trace and a `meta` object
  on its spans list (see Readers); Motel built the whole trace, however large, or failed.
- **Events.** A span keeps its first 128 events and says how many it dropped (see Field mapping);
  Motel kept them all.
- **Names.** A span's, event's or scope's name, an attribute's key, the `service.name` value and
  `severityText` are at most 4,096 bytes; an export with a longer one is refused with 400 naming
  the field (see Admission). The limit applies to every name and key the collector decodes and keeps. Content past depth 64
  (`VALUE_DEPTH`) is kept as raw text and counted as a value; events after the 128th are dropped
  unread. Neither is checked. Every value the collector decodes has its nested keys checked, whether or not a later value for the same key replaces it; for `service.name`, the value checked is the one kept (the last). Motel stored them all.
- **A lowered size limit empties the store.** A start with a smaller `--max-export-bytes` than
  the store has been started with empties it (see Run). Motel had no such limit.
- **A busy store** answers a query 503 with `Retry-After: 1` (see Fields and markers); Motel's
  query failed.
- **Exports that cost too much to decode.** An export whose decoding is charged more than eight
  times the size limit, or with a row of more than four times it, is refused with 413 (see
  Admission); Motel stored it.
- **A `limit` too large for a double.** A `limit` of about 309 digits or more is JavaScript's
  `Infinity`, which Motel replaced with the route's default, and so does the collector; a smaller
  one over the maximum is clamped to it.
- **Cursors.** A cursor that cannot be read answers 400; Motel read it as no cursor and answered
  page one again. Positions are exact when rows share a timestamp (nanoseconds and the row's id),
  where Motel's were milliseconds.
- **`AND`, `OR` and `NOT`.** An `operation` or `body` with one of these words, in capitals, made
  Motel's full-text query invalid and the request fail; here it is a word like any other.
- **Stats.** Only `agg=count` is kept; `avg_duration`, `p95_duration` and `error_rate` answer 400,
  and `groupBy=attr.*` counts every trace as `unknown`. A malformed stats request answers 400 with
  an `{error}` body; Motel's had none.
- **Dropped routes and parameters.** `/api/traces/search`, `/api/spans/:spanId`,
  `/api/spans/:spanId/logs`, `/api/logs/stats`, `/api/facets`, `/api/docs`, `/api/ai/*`,
  `/trace/:traceId`, `/openapi.json` and `/` answer 404. `attrContains.*`, `parentOperation`,
  `status` on searches, `minDurationMs` and `aiText` are ignored (a repeated or malformed `status`
  or `minDurationMs` answers 400, as in Motel).
- **Ids.** A trace or span id in a path or filter must be lowercase hex, as Motel stored and
  compared them; anything else matches nothing. Spans with ids that are not hex or base64 are
  refused at ingest (see Field mapping), where Motel stored them.
- **`/api/health`** answers `{ok, service, version}`; Motel's identity fields are not kept.

## Memory

glibc's allocator kept most of a burst of exports resident. The collector caps glibc at one
malloc arena. Each export, stored or refused, and each query's response, ends by asking the writer
to return memory. Once
250 ms have passed with no export finishing, the writer releases SQLite's page cache and calls
`malloc_trim`.

In the memory scenario's burst (`e2e/tests/docker-release-collector-memory.spec.ts`: 4 exports of
12,000 spans), it gives back about 98% of what the burst used within half a second.

### Memory ceilings

Each ceiling is a sum of terms computed by `src/memory.rs`. Each term is marked **enforced**,
when code refuses or cuts off whatever would pass it (a charge that refuses, a capacity, a
cut), or **measured**, when nothing refuses past it and the bound is how it was derived and
checked. `tests/memory.rs` counts every allocation (the Rust heap at glibc's chunk sizes, and
SQLite's own) for a corpus of 94 export shapes at a 1 MiB limit, and the densest exports at
16 MiB, and checks each peak against what the code allows it: decoding against its charge, the
writer against `writer_bytes`, a reader against `reader_bytes`. The process tests check resident
memory against the same terms. `M` is `--max-export-bytes`.

**One export, 15M:**

- its body as read, at most 2M while it grows without a `Content-Length` (enforced: reading
  stops past M; the 2 is the buffer doubling as it grows);
- its decompressed text when it is gzip, 2M more (enforced: inflating stops past M);
- what decoding is charged, `DECODE_SHARE` (8) × M, rows included until they are stored
  (enforced: the charge refuses with 413 before it allocates);
- serde_json's one scratch buffer, at most 3M (measured: not charged; the corpus checks it shape
  by shape). It unescapes a string into it, up to twice the string while it grows, and collects
  the digits of a long number into it (`float_roundtrip`: more than 19 significant digits or a
  long fraction), whether the number is valid or about to be refused as the wrong kind, growing
  by doubling with the old buffer beside the new: up to three times the number (measured, 3.0
  times: 2.999918 for a 622,593-byte number of the wrong type). No literal is longer than the body. serde_json collects a number's digits before any
  field's reader sees it, even to say it is the wrong type, so a field cannot refuse a number
  without them; only reading every number as raw text and parsing it ourselves would avoid
  that. What serde_json keeps to skip nested values is charged.

**One reader, `SKELETON_BYTES` + 12M + 3 MiB:**

- a trace's skeleton, `SKELETON_BYTES` (48 MiB) (enforced: counted at upper bounds; past it the
  trace is answered in part);
- the row being written and its resource, each at most `ROW_SHARE` (4) × M of text (enforced:
  refused at ingest past it, and a store started with a larger limit is emptied at
  start);
- SQLite's copy of one of them while it is read, 4M (measured: SQLite holds the value it hands
  over once; its heap is counted in the corpus);
- `RESOURCE_CACHE_BYTES` (256 KiB) of resources (enforced);
- `BODY_CHUNKS` (4) + 1 chunks of `CHUNK_BYTES` (64 KiB): four queued and the one waiting to be
  queued; the next is made only once that one is sent (enforced: the body queue's capacity);
- the HTTP server's write buffer, `SERVER_BUFFER_BYTES` (408 KiB) (measured: hyper's default,
  not the collector's code);
- its page cache, `READER_CACHE_BYTES` (2,000 KiB) (enforced by SQLite).

**The writer, 8 MiB + 12M + 2.0 MiB:**

- its page cache, `WRITER_CACHE_BYTES` (8 MiB) (enforced by SQLite);
- for the row it writes, at most 4M of text (enforced at ingest), held three times: SQLite's copy
  of its values, the record it builds and the stored row it compares (measured);
- at most `SUMMARY_BATCH` (4,096) fixed-size trace summaries, 2.016 MiB with the table they are
  kept in, never a copy of a name (enforced:
  past it they are written and forgotten).

| Ceiling           | M = 16 MiB (default) | M = 8 MiB | M = 4 MiB | Largest measured, at M = 1 MiB                                                            |
| ----------------- | -------------------- | --------- | --------- | ----------------------------------------------------------------------------------------- |
| One export        | 240 MiB              | 120 MiB   | 60 MiB    | decoding 7.3 MiB for a stored export (many resources), 8.0 MiB when refused at its budget |
| One reader        | 243 MiB              | 147 MiB   | 99 MiB    | 2.4 MiB (a value past depth 64)                                                           |
| The writer        | 202 MiB              | 106 MiB   | 58 MiB    | 3.4 MiB, page cache included (spans of ids only)                                          |
| All, four of each | 2,134 MiB            | 1,174 MiB | 694 MiB   | —                                                                                         |

"All" is `--max-pending` (4) exports, `READERS` (4) readers and the writer. At 16 MiB, the
densest export stored, 262,145 short logs, holds 86 MB while decoding (charged
119.6 MB, of the 128 MiB budget).

Answers that refuse an export carry at most `otlp::MESSAGE_BYTES` (256) of message, quoting at
most 24 characters of an offending value, so an ingest answer is a few hundred bytes whatever the
export held.

These are ceilings, not what the collector uses: no export or query passes an enforced term, and the measured ones hold for every shape measured. Every term but the
skeleton scales with M, and the large ones are reached only by exports built to be costly: the
product's exporter sends at most 1,000 spans an export (Effect's `maxBatchSize`), its spans hold at
most 16 attributes and its rows at most about 1.5 KB of text, and its traces at most 60 spans
(the local store on one development host). Measured by a reviewer, the collector took 7 to 18 MiB
at rest and 27 to 38 MiB under the product's load.

Lowering a default would be cheaper than any further code: `--max-export-bytes` of 4 MiB brings
the total to 694 MiB (a product export is a few MB at most, but the memory scenario sends 7.8 MiB
exports), and `SKELETON_BYTES` of 16 MiB, which still holds a 60,000-span trace whole, takes off
128 MiB more, to 566 MiB. Neither is lowered here.
