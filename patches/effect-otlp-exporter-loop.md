# OTLP exporter loop

Since Effect 4.1.2 an OTLP span or log exporter keeps no timer while idle. Its export
loop is a fiber that waits on a latch, and `push` opens the latch, which resumes that
fiber inside the caller's own call. Effect 4.0.1's loop slept on a timer and `push`
only filled the buffer.

Cloud builds its exporters once per isolate and exports when an event flushes
(`packages/telemetry/src/isolate.ts`). The loop fiber then last ran in one request,
and the first span or log of another request resumes it. A fiber resumes inside the
async context it suspended in, and workerd refuses that context from another
request: `Cannot call this AsyncLocalStorage bound function outside of the request
in which it was created`. The error is thrown out of `push`, so recording a log or
ending a span failed the request that did it, with a `500`. On managed local Cloud
it failed actor setup in `mcp-telemetry-privacy.spec.ts` and
`cloud-mcp-session-routing.spec.ts`.

`effect@4.1.4.patch` changes `observability/OtlpExporter`, in source and distributed
JavaScript: an exporter whose `exportInterval` is infinite runs no loop, and its
`push` opens no latch. It exports on a flush, on a full batch, and when its scope
closes, which is all an infinite interval could ever do. Exporters with a finite
interval are unchanged.

Executor's isolate exporters already used an infinite interval. Event exporters
(`telemetryLayer(config, "event")`, which app isolates use) used one hour as a
stand-in and now use an infinite interval too.

The patch has not been submitted upstream. Remove it when an Effect release does
not resume the exporter's fiber from `push`, or runs no loop without an interval.
