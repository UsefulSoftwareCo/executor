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

| Route             | Answer                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/traces` | `{insertedSpans}`: every span of the export, including resent spans that were already stored                                                                                            |
| `POST /v1/logs`   | `{insertedLogs}`                                                                                                                                                                        |
| `GET /api/health` | `{ok, service, version}`                                                                                                                                                                |
| `GET /api/ingest` | `{pending, maxPending, maxBytes, refused: {queueFull, tooLarge, invalid, storeFailed, overBound}, refusedBytes, lastRefusedAt, evictions: {passes, traces, spans, logs}, store: {...}}` |

Anything else answers 404 `{error}`. Query routes and the viewer come in later changes.

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
| `walFull`             | The log is over 32 MiB and exports are refused until a checkpoint empties it                                                                                                                     |
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
| Data over 110% of the bound, or the write-ahead log full      | 429, `Retry-After: 1`  | `overBound`   |

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
- Past 32 MiB exports are refused (`overBound`, `walFull`) and retention pauses. The writer still
  stores exports it had already admitted (at most `--max-pending`), and otherwise writes nothing
  to the log, the refusal counts included, until it is emptied; it tries a truncating checkpoint
  50 ms after the last attempt ended (the 250 ms spacing applies below 32 MiB). Each attempt can
  itself wait up to 50 ms for readers, so with a reader holding the log an attempt starts about
  every 100 ms. A reader that starts then reads only the
  database, older readers end, and the next checkpoint empties the log. With readers starting
  one after another, that takes up to two reads. A reader that holds one read open stops ingest
  until it ends. Stopping the collector saves the refusal counts once, a few kilobytes of log;
  a collector killed while the log is full loses the counts it had not saved.

So the data directory holds at most the bound plus 10% free pages, plus 32 MiB of log, plus what
the exports already admitted when the log filled add (at most `--max-pending` exports), plus the
log's index. Measured with a 64 MiB bound, four senders storing as fast as they could and a
reader beginning a 5-second read as soon as the last ended (a 30-second run, the collector capped
at 256 MiB a file): the data directory peaked at 101.5 MB, of which 64.8 MB database and 38.9 MB
log. Without the reader the log stayed under 5.5 MB and the directory under 70.1 MB. With that
reader, exports were refused while the log was full, in 109 of 120 quarter-second samples, and
the log was emptied as the reads turned over; a reader of the collector's own holds the log at
most 5 s (see Queries).

## Memory

glibc's allocator kept most of a burst of exports resident. The collector caps glibc at one
malloc arena. Each export, stored or refused, ends by asking the writer to return memory. Once
250 ms have passed with no export finishing, the writer releases SQLite's page cache and calls
`malloc_trim`.

In the memory scenario's burst (`e2e/tests/docker-release-collector-memory.spec.ts`: 4 exports of
12,000 spans), it gives back about 98% of what the burst used within half a second.
