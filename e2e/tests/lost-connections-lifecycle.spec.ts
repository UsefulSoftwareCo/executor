/**
 * The scenario lifecycle saves lost stage requests (`support/lifecycle.ts`), so a broken reporter
 * cannot print zero for a run that lost some. Runs under `lost-connections-lifecycle.config.ts`,
 * which loads the real setup file against a stand-in stage that resets the second request on each
 * connection. A request lost while a `layer` is built is outside any scenario; the setup file saves
 * it under this file. The config's global teardown checks both records were written.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { readLostRequests } from "../lost-requests.ts";
import { addStageOrigins } from "../support/lost-connections.ts";

/** The stand-in stage's origin, from the run's `run.json`. */
const origin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const run = yield* Config.String("EXECUTOR_E2E_RUN");
  const { origin } = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ origin: Schema.String })),
  )(yield* fs.readFileString(`${run}/run.json`));
  return origin;
});

/** A request that opens a connection, then one sent down it after it went back to the pool. */
const loseOne = Effect.gen(function* () {
  const stage = yield* origin;
  const http = yield* HttpClient.HttpClient;
  yield* http.get(`${stage}/warm`);
  yield* Effect.callback<void>((resume) => {
    setTimeout(() => resume(Effect.void), 50);
  });
  return yield* http.get(`${stage}/api/organizations/org/resources`);
}).pipe(Effect.provide(FetchHttpClient.layer));

// Built before any scenario: a lost request here belongs to no scenario.
const OutsideAnyScenario = Layer.effectDiscard(
  Effect.gen(function* () {
    addStageOrigins([yield* origin]);
    yield* loseOne.pipe(Effect.ignore);
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

layer(OutsideAnyScenario)("Lost stage requests reach the run's records", (it) => {
  it.effect("a request lost and sent again in a scenario is saved by the scenario lifecycle", () =>
    Effect.gen(function* () {
      expect((yield* loseOne).status).toBe(200);
    }),
  );

  it.effect("the record the scenario before made is on disk", () =>
    Effect.gen(function* () {
      const run = yield* Config.String("EXECUTOR_E2E_RUN");
      const records = yield* readLostRequests([run]);
      expect(
        records.filter((record) => record.scenario?.endsWith("is saved by the scenario lifecycle")),
      ).toHaveLength(1);
    }),
  );
});
