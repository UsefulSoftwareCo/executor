/** Events a local or self-host product process delivered to its own loopback collector. */
import { Config, Effect, FileSystem, Option, Path, Redacted, Schedule, Schema } from "effect";
import { Api, type Session } from "./api.ts";
import { collectorLinesWholeEnvironment } from "./collector-events.ts";
import { Target } from "./platform.ts";

/** One event as PostHog's `/batch/` endpoint receives it. */
export const DeliveredEvent = Schema.Struct({
  uuid: Schema.String,
  event: Schema.String,
  distinct_id: Schema.String,
  timestamp: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Json),
});
export type DeliveredEvent = typeof DeliveredEvent.Type;
const Batch = Schema.Struct({ api_key: Schema.String, batch: Schema.Array(DeliveredEvent) });

/**
 * The build the product process reports. Source runs report the checkout commit; the release
 * workflow's installed CLI reports the release version recorded in `apps/cli/package.json`.
 */
export const reportedBuild = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* Target;
  const packaged = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(Config.option);
  const version =
    target.metadata.target === "local" && Option.isSome(packaged)
      ? (yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
        )(yield* fs.readFileString(path.resolve("apps/cli/package.json")))).version
      : target.metadata.commit;
  const channel = /^\d+\.\d+\.\d+-beta\.\d+$/.test(version)
    ? "beta"
    : /^\d+\.\d+\.\d+$/.test(version)
      ? "latest"
      : "development";
  return { version, channel };
});

class AnalyticsPending extends Schema.TaggedError<AnalyticsPending>()("AnalyticsPending", {}) {}

/**
 * Everything the collector received: the raw text, for absence checks, and every event of its
 * complete lines, decoded, in delivery order. The whole collector is the subject here: these
 * scenarios run only on self-host and local, where the collector is the scenario's own product
 * process's, and they check what that instance sends at all. The text keeps a line still being
 * written, since that too is something the instance sent.
 */
export const deliveredAnalyticsWholeEnvironment = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* Target;
  const text = yield* fs.readFileString(`${target.directory}/analytics.ndjson`);
  const events: DeliveredEvent[] = [];
  for (const line of yield* collectorLinesWholeEnvironment("analytics.ndjson"))
    events.push(...(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Batch))(line)).batch);
  return { text, events };
});

/** Wait for delivery, across the whole collector. Test products send a partial batch every second. */
export const awaitAnalyticsWholeEnvironment = (
  ready: (events: readonly DeliveredEvent[]) => boolean,
) =>
  deliveredAnalyticsWholeEnvironment.pipe(
    Effect.flatMap((delivered) =>
      ready(delivered.events) ? Effect.succeed(delivered) : Effect.fail(new AnalyticsPending()),
    ),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
  );

/** The local agent API takes the host-issued bearer credential, not a browser origin. */
export const localAgent = Effect.gen(function* () {
  const api = yield* Api;
  const target = yield* Target;
  const session = yield* api.session();
  const agent: Session = {
    ...session,
    send: (method, path, data, headers = {}) => {
      const { origin: _origin, ...agentHeaders } = headers;
      return session.send(method, path, data, {
        ...agentHeaders,
        authorization: `Bearer ${Redacted.value(target.apiKey)}`,
      });
    },
  };
  return agent;
});
