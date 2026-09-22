/** Correlated browser timings for same-origin Executor responses only. */
import { Option, Schema } from "effect";

const milliseconds = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Entry = Schema.Struct({
  name: Schema.String,
  startTime: milliseconds,
  duration: milliseconds,
  domainLookupStart: milliseconds,
  domainLookupEnd: milliseconds,
  connectStart: milliseconds,
  connectEnd: milliseconds,
  secureConnectionStart: milliseconds,
  requestStart: milliseconds,
  responseStart: milliseconds,
  responseEnd: milliseconds,
  deliveryType: Schema.optional(Schema.String),
  transferSize: Schema.optional(milliseconds),
  decodedBodySize: Schema.optional(milliseconds),
  serverTiming: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      duration: milliseconds,
    }),
  ),
});
const decode = Schema.decodeUnknownOption(Entry);

/** Missing/restricted browser measurements stay absent instead of being labelled network or cold-start time. */
export const browserRequestTiming = (
  entry: unknown,
  origin: string,
): Readonly<Record<string, string | number>> | undefined => {
  const parsed = decode(entry);
  if (Option.isNone(parsed)) return;
  const value = parsed.value;
  // Cached Server-Timing IDs describe the original response, not this browser read.
  if (
    value.deliveryType === "cache" ||
    (value.transferSize === 0 && value.decodedBodySize !== undefined && value.decodedBodySize > 0)
  )
    return;
  if (!URL.canParse(value.name)) return;
  const url = new URL(value.name);
  if (url.origin !== origin || /\/api\/telemetry\/(traces|logs)\/?$/.test(url.pathname)) return;
  const trace = value.serverTiming.find((timing) => timing.name === "executor-trace")?.description;
  if (trace === undefined || !/^[a-f0-9]{32}$/.test(trace)) return;
  const attributes: Record<string, string | number> = {
    "executor.trace_id": trace,
    "browser.request.duration_ms": value.duration,
  };
  const span = value.serverTiming.find((timing) => timing.name === "executor-span")?.description;
  if (span !== undefined && /^(?!0{16}$)[a-f0-9]{16}$/.test(span))
    attributes["executor.span_id"] = span;
  const sampled = value.serverTiming.find(
    (timing) => timing.name === "executor-sampled",
  )?.description;
  if (sampled === "1" || sampled === "0") attributes["executor.trace_sampled"] = Number(sampled);
  const ray = value.serverTiming.find((timing) => timing.name === "cf-ray")?.description;
  if (ray !== undefined && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/i.test(ray))
    attributes["cloudflare.ray_id"] = ray.replace(/-[A-Z]{3}$/i, "");
  const phase = (name: string, start: number, end: number) => {
    if (start > 0 && end >= start) attributes[`browser.request.${name}_ms`] = end - start;
  };
  phase("dns", value.domainLookupStart, value.domainLookupEnd);
  phase("connection", value.connectStart, value.connectEnd);
  phase("tls", value.secureConnectionStart, value.connectEnd);
  phase("waiting_for_headers", value.requestStart, value.responseStart);
  phase("body", value.responseStart, value.responseEnd);
  if (value.responseStart > 0 && value.responseStart >= value.startTime)
    attributes["browser.request.time_to_first_byte_ms"] = value.responseStart - value.startTime;
  const handler = value.serverTiming.find((timing) => timing.name === "executor");
  if (handler !== undefined) attributes["executor.handler.duration_ms"] = handler.duration;
  return attributes;
};
