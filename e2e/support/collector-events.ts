import { Effect, FileSystem, Schema } from "effect";
import { Target } from "./platform.ts";
import { scopeOf, type Scope } from "./scope.ts";

export const collectorLinesWholeEnvironment = (
  file: "sentry.ndjson" | "analytics.ndjson" | "flags.ndjson" | "telemetry-relay.ndjson",
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

export const parseLeniently = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
export const field = (value: unknown, ...path: ReadonlyArray<string>): unknown => {
  let at = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null || Array.isArray(at)) return undefined;
    at = (at as Readonly<Record<string, unknown>>)[key];
  }
  return at;
};

export const AnalyticsEvent = Schema.Struct({
  event: Schema.String,
  distinct_id: Schema.optionalKey(Schema.String),
  properties: Schema.Record(Schema.String, Schema.Json),
});
export type AnalyticsEvent = typeof AnalyticsEvent.Type;
const decodeEvent = Schema.decodeUnknownEffect(AnalyticsEvent);

export const analyticsPerson = (event: AnalyticsEvent) =>
  event.distinct_id ?? event.properties.distinct_id;

export type AnalyticsScope = Scope<{
  readonly person: string;
  readonly organization: string;
  readonly app: string;
  readonly run: string;
}>;
const analyticsProperty = { organization: "organization_id", app: "app_id", run: "run_id" };

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

export const telemetryRelayRecords = (scope: Scope<{ readonly person: string }>) =>
  Effect.gen(function* () {
    const { value: person } = yield* scopeOf("A telemetry relay read", scope);
    const lines = yield* collectorLinesWholeEnvironment("telemetry-relay.ndjson");
    return lines.flatMap((line) => {
      const record = parseLeniently(line);
      const kind = field(record, "kind");
      const body = field(record, "body");
      if (kind === "feedback") return field(body, "account_id") === person ? [record] : [];
      if (kind !== "analytics") return [];
      const events = field(body, "events");
      if (!Array.isArray(events)) return [];
      const scopedEvents = events.filter((event) => field(event, "account_id") === person);
      return scopedEvents.length === 0 ? [] : [{ kind, body: { events: scopedEvents } }];
    });
  });

export const flagEvaluations = (person: string) =>
  scopeOf("A flag evaluation read", { person }).pipe(
    Effect.andThen(collectorLinesWholeEnvironment("flags.ndjson")),
    Effect.map(
      (lines) =>
        lines.filter((line) => field(parseLeniently(line), "distinct_id") === person).length,
    ),
  );

export const flagRequests = (person: string) =>
  scopeOf("A flag evaluation read", { person }).pipe(
    Effect.andThen(collectorLinesWholeEnvironment("flags.ndjson")),
    Effect.map((lines) =>
      lines
        .map(parseLeniently)
        .filter((request) => field(request, "distinct_id") === person)
        .map((request) => {
          const keys = field(request, "flag_keys_to_evaluate");
          return Array.isArray(keys) ? keys.map(String) : undefined;
        }),
    ),
  );
