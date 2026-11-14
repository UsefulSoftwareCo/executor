/**
 * Read the events a managed Cloud server sent to its loopback Sentry collector. Every scenario of a
 * Cloud job shares it, so a read names the scenario's own traces.
 */
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

/**
 * Every event item captured so far, from every scenario sharing the collector. The two envelope
 * header lines precede each event item.
 */
const eventLines = collectorLinesWholeEnvironment("sentry.ndjson").pipe(
  Effect.map((lines) =>
    lines.flatMap((line) => {
      const envelope = field(parseLeniently(line), "envelope");
      return typeof envelope === "string" ? envelope.split("\n").slice(2).filter(Boolean) : [];
    }),
  ),
);
/**
 * The event items of the scenario's own traces. Each item's trace is read leniently, so another
 * scenario's malformed event is passed over; the scenario's own are then decoded strictly.
 */
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

/**
 * Every event captured so far as sent, from every scenario sharing the collector, for a check
 * that a marker only this scenario sent appears in no report anywhere.
 */
export const sentryEventTextWholeEnvironment = eventLines;

/**
 * Every event captured so far, from every scenario sharing the collector, for a check of what no
 * report of a kind may hold, whoever caused it.
 */
export const sentryEventsWholeEnvironment = eventLines.pipe(
  Effect.map((lines) => lines.map((value) => Schema.decodeUnknownSync(EventLine)(value))),
);

/** The events captured so far for the scenario's own traces. */
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
/** The captured exceptions of the scenario's own traces, each with its message and trace. */
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

/** Poll the collector until the events of the scenario's own traces satisfy `until`. */
export const awaitSentryEvents = (
  traces: ReadonlyArray<string>,
  until: (events: ReadonlyArray<SentryEvent>) => boolean,
) =>
  sentryEvents(traces).pipe(
    Effect.repeat({ schedule: Schedule.spaced("100 millis"), until }),
    Effect.timeout("10 seconds"),
  );

/** Events captured for one trace. */
export const traceEvents = (events: ReadonlyArray<SentryEvent>, trace: string) =>
  events.filter((event) => event.contexts?.trace?.trace_id === trace);

/** Exception types captured for one trace. */
export const traceExceptionTypes = (events: ReadonlyArray<SentryEvent>, trace: string) =>
  traceEvents(events, trace).flatMap(
    (event) => event.exception?.values.map((value) => value.type) ?? [],
  );
