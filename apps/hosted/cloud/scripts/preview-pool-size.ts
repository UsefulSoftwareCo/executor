/**
 * Set a PlanetScale preview branch's connection settings: cap its PgBouncer pool so Workers leave
 * room for migrations, and, when `MAX_CONNECTIONS` is given, raise Postgres's `max_connections`.
 * A new branch allows 25 connections whatever its size; PgBouncer's default of 20 per role can
 * take all of them. Raising `max_connections` restarts Postgres, so the migration job waits for
 * this one. PlanetScale credentials come from the deploy environment the command inherits.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Config, Effect, Option, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class PoolSizeFailed extends Schema.TaggedError<PoolSizeFailed>()("PoolSizeFailed", {
  message: Schema.String,
}) {}

const Parameters = Schema.Array(
  Schema.Struct({ namespace: Schema.String, name: Schema.String, value: Schema.String }),
);
const Change = Schema.Struct({ id: Schema.String, state: Schema.String });
const Changes = Schema.Struct({ data: Schema.Array(Change) });

const apply = Effect.gen(function* () {
  const organization = yield* Config.NonEmptyString("PLANETSCALE_ORGANIZATION");
  const database = yield* Config.NonEmptyString("TEST_STAGE_DATABASE");
  const branch = yield* Config.NonEmptyString("TEST_STAGE_DATABASE_BRANCH");
  const size = yield* Config.Int("POOL_SIZE");
  const connections = yield* Config.Int("MAX_CONNECTIONS").pipe(Config.option);
  const id = yield* Config.Redacted("PLANETSCALE_API_TOKEN_ID");
  const token = yield* Config.Redacted("PLANETSCALE_API_TOKEN");
  if (!/^test-[a-z0-9-]+$/.test(branch))
    return yield* new PoolSizeFailed({ message: "Only preview branches are configured here" });
  const client = yield* HttpClient.HttpClient;
  const base = `https://api.planetscale.com/v1/organizations/${organization}/databases/${database}/branches/${branch}`;
  // Responses are decoded by each caller; failures report only the status.
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const response = yield* client.execute(
        HttpClientRequest.setHeader(
          request,
          "authorization",
          `${Redacted.value(id)}:${Redacted.value(token)}`,
        ),
      );
      if (response.status !== 200)
        return yield* new PoolSizeFailed({ message: `PlanetScale returned ${response.status}` });
      return yield* response.json;
    }).pipe(
      Effect.catchTag("HttpClientError", () =>
        Effect.fail(new PoolSizeFailed({ message: "PlanetScale request failed" })),
      ),
    );
  const current = yield* send(HttpClientRequest.get(`${base}/parameters`)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Parameters)),
  );
  const value = (namespace: string, name: string) =>
    current.find((parameter) => parameter.namespace === namespace && parameter.name === name)
      ?.value;
  const pgbouncer =
    value("pgbouncer", "default_pool_size") === String(size)
      ? {}
      : { pgbouncer: { default_pool_size: String(size) } };
  const pgconf = Option.match(connections, {
    onNone: () => ({}),
    onSome: (wanted) =>
      value("pgconf", "max_connections") === String(wanted)
        ? {}
        : { pgconf: { max_connections: String(wanted) } },
  });
  if (Object.keys(pgbouncer).length === 0 && Object.keys(pgconf).length === 0) return;
  // A branch can still be applying its own creation or resize; PlanetScale then refuses the change.
  const change = yield* send(
    yield* HttpClientRequest.patch(`${base}/changes`).pipe(
      HttpClientRequest.bodyJson({ parameters: { ...pgbouncer, ...pgconf } }),
    ),
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Change)),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
  );
  // The change reloads PgBouncer, and restarts Postgres for `max_connections`; wait until
  // PlanetScale reports it complete.
  yield* send(HttpClientRequest.get(`${base}/changes`)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Changes)),
    Effect.flatMap(({ data }) =>
      data.find((entry) => entry.id === change.id)?.state === "completed"
        ? Effect.void
        : Effect.fail(
            new PoolSizeFailed({ message: "The connection settings are still applying" }),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
  );
});

NodeRuntime.runMain(apply.pipe(Effect.timeout("8 minutes"), Effect.provide(FetchHttpClient.layer)));
