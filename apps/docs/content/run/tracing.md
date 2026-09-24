---
title: Tracing
description: "Read a slow request as a waterfall. Executor bundles a local trace store and viewer, and exports OTLP to any collector you point it at instead."
---

When a request is slow, the useful question is which part was slow: building the
app, an account lookup, a stored-data query, or the upstream service answering.
Executor already produces spans for all of that. You only have to decide where
they go.

## The bundled collector

Local, desktop and self-host builds package [Motel](https://github.com/kitlangton/motel),
a small OTLP store and viewer over a SQLite file. It is the default destination,
so traces are being recorded already.

Where it writes depends on where you run:

| Deployment | Diagnostics directory                                                       |
| ---------- | --------------------------------------------------------------------------- |
| Local      | `<EXECUTOR_DATA_DIR>/diagnostics`, by default `.local/executor/diagnostics` |
| Self-host Docker | `/app/motel-data`, separate from the product volume                  |

The local diagnostics directory holds:

- `collector.json` — the collector's state, process ID, query URL and database
  path.
- `telemetry.sqlite` — the stored traces and logs.
- `executor-local.jsonl` or `executor-selfhost.jsonl` — Effect logs, written
  independently of the collector.

Motel keeps seven days and targets 1 GiB. Each log file keeps four rotated
archives at about 10 MiB each.

In self-host Docker, Motel runs inside workerd and stores its data separately
from `/app/data`. Replacing the container discards telemetry by default. Mount
a separate volume at `/app/motel-data` to retain it. The container does not
include Node or Bun. Product process logs go to the container log.

The collector binds to container loopback on port 4318 and publishes no port.
For the container named `executor-v2` in the [self-host instructions](/run/self-host),
query it with a temporary container that shares its network:

```bash
docker run --rm --network container:executor-v2 curlimages/curl \
  --fail --silent --show-error 'http://127.0.0.1:4318/api/traces?limit=20'
```

The collector serves `/api/health`, `/api/traces`,
`/api/traces/<trace-id>/spans`, `/api/logs/search` and `/openapi.json`.

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

## Using Motel on your own machine

Motel runs standalone too. It needs [Bun](https://bun.sh/) and listens on port
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
