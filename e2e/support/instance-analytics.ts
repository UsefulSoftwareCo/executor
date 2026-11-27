import { Config, Effect, FileSystem, Option, Path, Schedule, Schema } from "effect";
import { Api, type Session } from "./api.ts";
import { collectorLinesWholeEnvironment } from "./collector-events.ts";
import { Target } from "./platform.ts";
import { reveal } from "./failure-text.ts";

export const DeliveredEvent = Schema.Struct({
  uuid: Schema.String,
  event: Schema.String,
  distinct_id: Schema.String,
  timestamp: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Json),
});
export type DeliveredEvent = typeof DeliveredEvent.Type;
const Batch = Schema.Struct({ api_key: Schema.String, batch: Schema.Array(DeliveredEvent) });

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

export const deliveredAnalyticsWholeEnvironment = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* Target;
  const text = yield* fs.readFileString(`${target.directory}/analytics.ndjson`);
  const events: DeliveredEvent[] = [];
  for (const line of yield* collectorLinesWholeEnvironment("analytics.ndjson"))
    events.push(...(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Batch))(line)).batch);
  return { text, events };
});

export const awaitAnalyticsWholeEnvironment = (
  ready: (events: readonly DeliveredEvent[]) => boolean,
) =>
  deliveredAnalyticsWholeEnvironment.pipe(
    Effect.flatMap((delivered) =>
      ready(delivered.events) ? Effect.succeed(delivered) : Effect.fail(new AnalyticsPending()),
    ),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
  );

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
        authorization: `Bearer ${reveal(target.apiKey)}`,
      });
    },
  };
  return agent;
});
