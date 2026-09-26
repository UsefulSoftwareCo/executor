/** Read the events a managed Cloud server sent to its loopback Sentry collector. */
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { Target } from "./platform.ts";

const Envelope = Schema.fromJsonString(Schema.Struct({ envelope: Schema.String }));
export const SentryEvent = Schema.Struct({
  exception: Schema.optional(
    Schema.Struct({ values: Schema.Array(Schema.Struct({ type: Schema.String })) }),
  ),
  user: Schema.optional(Schema.Struct({ id: Schema.String })),
  tags: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  contexts: Schema.optional(
    Schema.Struct({ trace: Schema.optional(Schema.Struct({ trace_id: Schema.String })) }),
  ),
});
export type SentryEvent = typeof SentryEvent.Type;
const EventLine = Schema.fromJsonString(SentryEvent);

/** Every event captured so far. The two envelope header lines precede each event item. */
export const sentryEvents = Effect.gen(function* () {
  const target = yield* Target,
    fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(`${target.directory}/sentry.ndjson`);
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) =>
      Schema.decodeUnknownSync(Envelope)(line)
        .envelope.split("\n")
        .slice(2)
        .filter(Boolean)
        .map((value) => Schema.decodeUnknownSync(EventLine)(value)),
    );
});

/** Poll the collector until the captured events satisfy `until`. */
export const awaitSentryEvents = (until: (events: ReadonlyArray<SentryEvent>) => boolean) =>
  sentryEvents.pipe(
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
