/** Transfer test-stage fixture authority to the runner's local process; never persist credentials. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Config, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

const configure = Effect.scoped(
  Effect.gen(function* () {
    const stage = yield* Config.NonEmptyString("ALCHEMY_STAGE");
    const origin = yield* Config.NonEmptyString("BETTER_AUTH_URL");
    const branch = yield* Config.NonEmptyString("TEST_STAGE_DATABASE_BRANCH");
    const control = yield* Config.String("TEST_STAGE_FIXTURE_CONTROL").pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              origin: Schema.String,
              token: Schema.RedactedFromValue(Schema.String),
            }),
          ),
        ),
      ),
    );
    const receiver = URL.parse(control.origin);
    if (
      !/^test-(?:e2e|perf)-[a-z0-9-]+$/.test(stage) ||
      branch !== stage ||
      origin !== `https://${stage.slice(5)}.executor.engineering` ||
      receiver === null ||
      receiver.origin !== control.origin ||
      receiver.protocol !== "http:" ||
      receiver.hostname !== "127.0.0.1"
    )
      return yield* Effect.die(
        new Error("Fixture setup requires its own dedicated test stage and local receiver"),
      );
    const database = yield* Config.Redacted("DATABASE_URL"),
      secret = yield* Config.Redacted("BETTER_AUTH_SECRET");
    const request = yield* HttpClientRequest.post(`${control.origin}/configure`).pipe(
      HttpClientRequest.bearerToken(control.token),
      HttpClientRequest.bodyJson({
        origin,
        stage,
        database: Redacted.value(database),
        secret: Redacted.value(secret),
        databaseName: yield* Config.NonEmptyString("TEST_STAGE_DATABASE_NAME"),
        databaseUsername: yield* Config.NonEmptyString("TEST_STAGE_DATABASE_USERNAME"),
      }),
    );
    const response = yield* (yield* HttpClient.HttpClient).execute(request);
    if (response.status !== 200) return yield* Effect.die(new Error("Local fixture setup failed"));
    yield* response.text;
  }),
).pipe(
  Effect.timeout("30 seconds"),
  Effect.catchCause(() =>
    Effect.die(new Error("Test fixture setup failed; inspect the local fixture process")),
  ),
);
NodeRuntime.runMain(configure.pipe(Effect.provide(FetchHttpClient.layer)));
