import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { liveOpenapiFixture } from "../support/live-openapi.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Live OpenAPI", (it) => {
  it.effect(scenarios.liveOpenapiCache.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* liveOpenapiFixture(60000, { staleFor: 0 });
        const { call } = fixture;
        const first = yield* call("old", "old");
        expect(first.status).toBe(200);
        expect(yield* body(Schema.Json, first)).toEqual({
          token: "synthetic-live-key",
          stolen: null,
        });
        const fetched = yield* fixture.downloads;
        expect((yield* call("old", "old")).status).toBe(200);
        expect(yield* fixture.downloads).toBe(fetched);
        const beforeInvalid = yield* fixture.calls;
        expect((yield* call("old", "wrong")).status).toBe(422);
        expect(yield* fixture.calls).toBe(beforeInvalid);
      }),
    ),
  );
});
