---
title: Tracing
description: "Read a slow request as a waterfall. Executor bundles a local trace store and viewer, and exports OTLP to any collector you point it at instead."
---

When a request is slow, the useful question is which part was slow: building the
app, an account lookup, a stored-data query, or the upstream service answering.
Executor already produces spans for all of that. You only have to decide where
they go.

## The bundled collector

Local, desktop and self-host builds package Executor's telemetry collector, a small OTLP store over
one SQLite file. It is the default destination, so traces are being recorded already. Local and
desktop builds also serve a trace viewer from it.

Where it writes depends on where you run:

| Deployment | Diagnostics directory                                                       |
| ---------- | --------------------------------------------------------------------------- |
| Local      | `<EXECUTOR_DATA_DIR>/diagnostics`, by default `~/.executor/v2/cli/diagnostics` |
| Self-host Docker | `EXECUTOR_MOTEL_DATA_DIR`, by default `/app/motel-data` (the name is historical) |

The local diagnostics directory holds:

- `collector.json` — the collector's state, process ID, URL and data directory.
  Open the URL in a browser for the trace viewer.
- `collector/` — the stored traces and logs, in `telemetry.sqlite`.
- `motel/` — only after an upgrade from a version that ran Motel, the collector
  Executor bundled before: its traces and logs, up to about 1 GiB. Executor neither
  reads nor removes it. To reclaim the space, stop Executor and delete it, for the
  default local directory with `rm -rf ~/.executor/v2/cli/diagnostics/motel`.
- `executor-local.jsonl` or `executor-selfhost.jsonl` — Effect logs, written
  independently of the collector. The background Executor writes its logs only
  here.

The collector keeps seven days and at most 1 GiB, evicting the oldest first. Each log file keeps
four rotated archives at about 10 MiB each.

In self-host Docker the collector runs as its own process beside the product and keeps its files in
`EXECUTOR_MOTEL_DATA_DIR`. This directory must be separate from `/app/data`. Replacing the
container discards telemetry by default. Mount a separate volume there to retain it. An image that
ran Motel left its store, up to about 1 GiB, in a `motel` folder of that directory, which the
collector neither reads nor removes. Without a volume there it went with the old container; with
one, delete it by hand: `docker exec executor-v2 rm -rf /app/motel-data/motel`. The container does not include Node or Bun, and does not serve the trace viewer.

The collector also stores the log records that Executor writes. A record written
during a request has the trace ID of that request. Executor does not write a
log record for each request, so most requests produce only a trace. Warnings,
errors, and app page requests produce log records. An empty `/api/logs/search`
result does not mean that log export is broken. The search covers the last
hour by default. Set `lookback`, for example `lookback=24h`, to search further
back. Each log record also goes to the container log.

The collector listens only on a private Unix socket inside the container. It
has no network port, so apps cannot reach it, even when
`EXECUTOR_APPS_ALLOW_PRIVATE_FETCH` is on. For the container named `executor-v2`
in the [self-host instructions](/run/self-host), query it through the host
process:

```bash
docker exec executor-v2 executor-host telemetry '/api/traces?limit=20'
```

Images before this change served the collector on container loopback port 4318.
That port is gone. Scripts that read `http://127.0.0.1:4318` must use
`executor-host telemetry` instead. An `OTEL_EXPORTER_OTLP_*` variable that points
at `127.0.0.1:4318` now sends to a port nothing listens on: remove it to use the
bundled collector, or point it at your own collector.

The collector serves `/api/health`, `/api/ingest` (what it stored, refused and evicted),
`/api/services`, `/api/traces`, `/api/traces/<trace-id>`, `/api/traces/<trace-id>/spans`,
`/api/traces/<trace-id>/logs`, `/api/spans/search`, `/api/logs` and `/api/logs/search`.

## Exporting to your own collector

Set an OTLP endpoint and Executor exports there instead. Any collector works:
the OpenTelemetry Collector, Grafana Alloy, Jaeger, or a hosted backend.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.local:4318
```

| Variable                              | Purpose                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | Base URL for all three signals.                                            |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | Full traces URL. Overrides the base for traces.                            |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | Full logs URL.                                                             |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Full metrics URL.                                                          |
| `OTEL_EXPORTER_OTLP_HEADERS`          | Headers for a collector that needs authentication. Use URL-encoded values. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`   | Headers for traces only. The logs and metrics signals have their own.      |
| `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` | Set to `http/json` for a collector that does not accept protobuf metrics.  |
| `EXECUTOR_BUILD_VERSION`              | Identifies the build, normally the commit SHA.                             |
| `EXECUTOR_ENVIRONMENT`                | Identifies the deployment. Locally this defaults to `development`.         |

Traces and logs go out as OTLP over HTTP with a JSON payload. Metrics default to
OTLP protobuf.

For a hosted backend, put the credential in the headers:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com
OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer%20<token>'
```

The self-host compose file passes every one of these through. An unset variable
stays absent, which keeps the bundled collector as the destination.

## Turning off the bundled collector

Set a traces or logs endpoint. Executor then sends nothing to the bundled collector: no
traces and no logs. One variable is enough:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://collector.local:4318/v1/traces
```

With only the traces endpoint set, log records are not exported. The server's
own log records still go to the container log, and locally to the log file in
the diagnostics directory. Errors and diagnostics the browser reports do not:
Executor forwards them only to a logs endpoint, and with none set they are not
kept anywhere. Set `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` too if your collector
should receive logs, including the browser's. With only the logs endpoint set,
traces are not recorded anywhere.

With either endpoint set, local and desktop builds do not start the collector at all.
In self-host Docker, the collector process still starts, because the host
always supervises it. It receives no new records and stays idle. Records it
stored before the switch remain until its retention removes them. There is no setting that
skips the Docker collector process.

To see that the change took effect, check that new traces reach your
collector and that the bundled one records none. Switching does not delete what it
already stored, so a retained volume still lists its earlier traces. A
few minutes after the restart, use Executor, then list the traces the bundled collector
received in the last two minutes. The result stays empty:

```bash
docker exec executor-v2 executor-host telemetry '/api/traces?lookback=2m&limit=20'
```

## Using Motel on your own machine

[Motel](https://github.com/kitlangton/motel), the collector Executor bundled before, runs
standalone and makes a convenient destination for a server you run yourself. It needs [Bun](https://bun.sh/) and listens on port
`27686`.

```bash
bunx @kitlangton/motel
```

That starts ingest and opens the terminal viewer. For ingest without the viewer,
run `bunx @kitlangton/motel server`.

Point a server on the same machine at it:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:27686/v1/traces
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:27686/v1/logs
```

From a container, Motel is on the host and binds loopback by default, so it also
has to listen on an address the container can reach:

```bash
MOTEL_OTEL_HOST=0.0.0.0 bunx @kitlangton/motel server
```

`MOTEL_OTEL_HOST=0.0.0.0` exposes the trace store to your whole network. Traces
carry request URLs and timings, and logs carry more. Use it only on a network
you trust.

## Reading a trace

A single request is a set of spans, each indented under its parent, with the
time it held:

```text
http.server GET                        31ms
  executor.stack.http.resolve          28ms
    executor.stack.build               28ms
      executor.stack.scoped_executor   27ms
        executor.plugins.init          16ms
        executor.stack.create_executor  2ms
        executor.subject.touch          7ms
```

The indentation is where the answer is. Time held by `http.server` but not by
any child is time spent outside the instrumented code: the network in front of
the server, or a tunnel. Time inside one child tells you which phase to open
next.

A request that arrives with a `traceparent` header continues that trace instead
of starting a new one, so a call through a proxy keeps one trace ID end to end.
