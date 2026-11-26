import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { readLostRequests } from "../lost-requests.ts";
import { addStageOrigins } from "../support/lost-connections.ts";

const origin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const run = yield* Config.String("EXECUTOR_E2E_RUN");
  const { origin } = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ origin: Schema.String })),
  )(yield* fs.readFileString(`${run}/run.json`));
  return origin;
});

const loseOne = Effect.gen(function* () {
  const stage = yield* origin;
  const http = yield* HttpClient.HttpClient;
  return yield* http.get(`${stage}/lose`);
}).pipe(Effect.provide(FetchHttpClient.layer));

const OutsideAnyScenario = Layer.effectDiscard(
  Effect.gen(function* () {
    addStageOrigins([yield* origin]);
    yield* loseOne.pipe(Effect.ignore);
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

layer(OutsideAnyScenario)("Lost stage requests reach the run's records", (it) => {
  it.effect("a request lost in a scenario is saved by the scenario lifecycle", () =>
    Effect.gen(function* () {
      expect((yield* loseOne.pipe(Effect.result))._tag).toBe("Failure");
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
