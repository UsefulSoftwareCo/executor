/**
 * Read what a managed environment's loopback collector received: Sentry envelopes, PostHog events
 * and flag evaluations. On Cloud every scenario of a job shares one collector, so a scenario reads
 * only its own: the events of its traces, its organization, its apps or runs, or its people. The
 * collector appends while scenarios read, so a read keeps only complete, newline-terminated lines;
 * a line still being written is read next time. Each read picks out the scenario's own events
 * leniently and decodes only those strictly, so another scenario's malformed event cannot fail it.
 */
import { Effect, FileSystem, Schema } from "effect";
import { Target } from "./platform.ts";
import { scopeOf, type Scope } from "./scope.ts";

/**
 * The complete lines of one of the environment's collector files, in delivery order, from every
 * scenario that shares the collector. Only for the scoped readers in `support/`, which pick out
 * the scenario's own lines from these.
 */
export const collectorLinesWholeEnvironment = (
  file: "sentry.ndjson" | "analytics.ndjson" | "flags.ndjson",
) =>
  Effect.gen(function* () {
    const target = yield* Target,
      fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(`${target.directory}/${file}`);
    const end = text.lastIndexOf("\n");
    return end < 0
      ? []
      : text
          .slice(0, end)
          .split("\n")
          .filter((line) => line.length > 0);
  });

/** A JSON value read without a schema, or undefined when the text is not JSON. */
export const parseLeniently = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
/** The value at `path` in a value read leniently, when every step is an object. */
export const field = (value: unknown, ...path: ReadonlyArray<string>): unknown => {
  let at = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null || Array.isArray(at)) return undefined;
    at = (at as Readonly<Record<string, unknown>>)[key];
  }
  return at;
};

/** A captured event: the server names its person on the event, the browser SDK in its properties. */
export const AnalyticsEvent = Schema.Struct({
  event: Schema.String,
  distinct_id: Schema.optionalKey(Schema.String),
  properties: Schema.Record(Schema.String, Schema.Json),
});
export type AnalyticsEvent = typeof AnalyticsEvent.Type;
const decodeEvent = Schema.decodeUnknownEffect(AnalyticsEvent);

/** The person an event is about, wherever its sender names them. */
export const analyticsPerson = (event: AnalyticsEvent) =>
  event.distinct_id ?? event.properties.distinct_id;

/**
 * Which events a read returns, by one thing the scenario owns: a person it signed in (their
 * distinct ID), its organization (`organization_id`), or an app or run it created (`app_id`,
 * `run_id`).
 */
export type AnalyticsScope = Scope<{
  readonly person: string;
  readonly organization: string;
  readonly app: string;
  readonly run: string;
}>;
const analyticsProperty = { organization: "organization_id", app: "app_id", run: "run_id" };

/** The scenario's events in `scope` that the collector received so far, in delivery order. */
export const analyticsEvents = (scope: AnalyticsScope) =>
  Effect.gen(function* () {
    const { kind, value } = yield* scopeOf("An analytics read", scope);
    const property = (analyticsProperty as Readonly<Record<string, string>>)[kind];
    if (kind !== "person" && property === undefined)
      return yield* Effect.die(new Error(`An analytics read has no scope named ${kind}`));
    const owned = (event: unknown) =>
      property === undefined
        ? (field(event, "distinct_id") ?? field(event, "properties", "distinct_id")) === value
        : field(event, "properties", property) === value;
    const lines = yield* collectorLinesWholeEnvironment("analytics.ndjson");
    const events = lines.flatMap((line) => {
      const batch = field(parseLeniently(line), "batch");
      return Array.isArray(batch) ? batch.filter(owned) : [];
    });
    return yield* Effect.forEach(events, (event) => decodeEvent(event));
  });

/** How many times the product asked the collector for one person's flags. */
export const flagEvaluations = (person: string) =>
  scopeOf("A flag evaluation read", { person }).pipe(
    Effect.andThen(collectorLinesWholeEnvironment("flags.ndjson")),
    Effect.map(
      (lines) =>
        lines.filter((line) => field(parseLeniently(line), "distinct_id") === person).length,
    ),
  );
