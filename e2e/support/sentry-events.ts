import { Effect, Schedule, Schema } from "effect";
import { collectorLinesWholeEnvironment, field, parseLeniently } from "./collector-events.ts";
import { scopeOf } from "./scope.ts";

export const SentryEvent = Schema.Struct({
  exception: Schema.optional(
    Schema.Struct({
      values: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          value: Schema.optional(Schema.String),
          stacktrace: Schema.optional(Schema.Struct({ frames: Schema.Array(Schema.Unknown) })),
        }),
      ),
    }),
  ),
  user: Schema.optional(Schema.Struct({ id: Schema.String })),
  tags: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  contexts: Schema.optional(
    Schema.Struct({ trace: Schema.optional(Schema.Struct({ trace_id: Schema.String })) }),
  ),
});
export type SentryEvent = typeof SentryEvent.Type;
const EventLine = Schema.fromJsonString(SentryEvent);

const eventLines = collectorLinesWholeEnvironment("sentry.ndjson").pipe(
  Effect.map((lines) =>
    lines.flatMap((line) => {
      const envelope = field(parseLeniently(line), "envelope");
      return typeof envelope === "string" ? envelope.split("\n").slice(2).filter(Boolean) : [];
    }),
  ),
);
const scenarioLines = (traces: ReadonlyArray<string>) =>
  scopeOf("A Sentry read", { traces }).pipe(
    Effect.andThen(eventLines),
    Effect.map((lines) => {
      const owned = new Set(traces);
      return lines.filter((line) => {
        const trace = field(parseLeniently(line), "contexts", "trace", "trace_id");
        return typeof trace === "string" && owned.has(trace);
      });
    }),
  );

export const sentryEventTextWholeEnvironment = eventLines;

export const sentryEventsWholeEnvironment = eventLines.pipe(
  Effect.map((lines) => lines.map((value) => Schema.decodeUnknownSync(EventLine)(value))),
);

export const sentryEvents = (traces: ReadonlyArray<string>) =>
  scenarioLines(traces).pipe(
    Effect.map((lines) => lines.map((value) => Schema.decodeUnknownSync(EventLine)(value))),
  );

const ExceptionLine = Schema.fromJsonString(
  Schema.Struct({
    exception: Schema.optional(
      Schema.Struct({
        values: Schema.Array(
          Schema.Struct({ type: Schema.String, value: Schema.optional(Schema.String) }),
        ),
      }),
    ),
    contexts: SentryEvent.fields.contexts,
  }),
);
export const sentryExceptions = (traces: ReadonlyArray<string>) =>
  scenarioLines(traces).pipe(
    Effect.map((lines) =>
      lines.flatMap((line) => {
        const event = Schema.decodeUnknownSync(ExceptionLine)(line);
        return (event.exception?.values ?? []).map((exception) => ({
          ...exception,
          trace: event.contexts?.trace?.trace_id,
        }));
      }),
    ),
  );

export const awaitSentryEvents = (
  traces: ReadonlyArray<string>,
  until: (events: ReadonlyArray<SentryEvent>) => boolean,
) =>
  sentryEvents(traces).pipe(
    Effect.repeat({ schedule: Schedule.spaced("100 millis"), until }),
    Effect.timeout("10 seconds"),
  );

export const traceEvents = (events: ReadonlyArray<SentryEvent>, trace: string) =>
  events.filter((event) => event.contexts?.trace?.trace_id === trace);

export const traceExceptionTypes = (events: ReadonlyArray<SentryEvent>, trace: string) =>
  traceEvents(events, trace).flatMap(
    (event) => event.exception?.values.map((value) => value.type) ?? [],
  );
