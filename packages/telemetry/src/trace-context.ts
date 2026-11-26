import { Effect, Option, Schema, Tracer } from "effect";

export const TraceContext = Schema.Struct({
  traceId: Schema.String.check(Schema.isPattern(/^(?!0{32}$)[a-f0-9]{32}$/u)),
  spanId: Schema.String.check(Schema.isPattern(/^(?!0{16}$)[a-f0-9]{16}$/u)),
  sampled: Schema.Boolean,
});
export type TraceContext = typeof TraceContext.Type;

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

export const externalTrace = (input: unknown) =>
  Schema.decodeUnknownOption(TraceContext)(input).pipe(
    Option.map((trace) => Tracer.externalSpan(trace)),
  );

export const traceLinks = (
  input: unknown,
  relationship: string,
): ReadonlyArray<Tracer.SpanLink> => {
  const span = externalTrace(input);
  return Option.isSome(span)
    ? [{ span: span.value, attributes: { "executor.link.kind": relationship } }]
    : [];
};
