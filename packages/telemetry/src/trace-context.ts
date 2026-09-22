/** Safe W3C identifiers for correlation across transports that do not carry HTTP headers. */
import { Effect, Option, Schema, Tracer } from "effect";

/** Trace metadata conveys no authorization and must never contain app values or credentials. */
export const TraceContext = Schema.Struct({
  traceId: Schema.String.check(Schema.isPattern(/^(?!0{32}$)[a-f0-9]{32}$/)),
  spanId: Schema.String.check(Schema.isPattern(/^(?!0{16}$)[a-f0-9]{16}$/)),
  sampled: Schema.Boolean,
});
/** Decoded, non-authorizing trace identity. */
export type TraceContext = typeof TraceContext.Type;

/** Capture only the current span's transport-safe identity. */
export const currentTraceContext = Effect.currentSpan.pipe(
  Effect.option,
  Effect.map(
    Option.map((span): TraceContext => ({
      traceId: span.traceId,
      spanId: span.spanId,
      sampled: span.sampled,
    })),
  ),
  Effect.map(Option.getOrUndefined),
);

/** Invalid or absent optional telemetry never prevents otherwise valid application data from rendering. */
export const externalTrace = (input: unknown) =>
  Schema.decodeUnknownOption(TraceContext)(input).pipe(
    Option.map((trace) => Tracer.externalSpan(trace)),
  );

/** Link a measurement to the observed request without inventing a parent/child lifetime. */
export const traceLinks = (
  input: unknown,
  relationship: string,
): ReadonlyArray<Tracer.SpanLink> => {
  const span = externalTrace(input);
  return Option.isSome(span)
    ? [{ span: span.value, attributes: { "executor.link.kind": relationship } }]
    : [];
};
