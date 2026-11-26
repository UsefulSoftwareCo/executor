import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { openapiExampleIdsFixture } from "../support/openapi-example-ids.ts";
import { scenarios } from "../test-plan.ts";

const Listing = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Json })),
});

layer(HostedLive, { excludeTestServices: true })("Live OpenAPI example ids", (it) => {
  it.effect(scenarios.liveOpenapiExampleIds.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* openapiExampleIdsFixture;

        const listed = yield* fixture.tools;
        expect(listed.status).toBe(200);
        const [tool] = (yield* body(Listing, listed)).items;
        expect(tool?.name).toBe("alerts.listAlerts");
        expect(tool?.inputSchema).toMatchObject({
          $defs: {
            IncidentReference: { "x-examples": { "Example 1": { id: "string" } } },
            AlertFilter: { "x-examples": { "Example 1": { incident: { id: "string" } } } },
          },
        });

        const called = yield* fixture.call({ incident: "PINC1", filter: "open" });
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(yield* body(Schema.Json, called)).toEqual({ incident: "PINC1", filter: "open" });
        expect(yield* fixture.calls).toBe(1);
      }),
    ),
  );
});
