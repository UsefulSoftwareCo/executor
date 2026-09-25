import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { liveOpenapiFixture } from "../support/live-openapi.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Live OpenAPI", (it) => {
  it.effect(scenarios.liveOpenapi.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* liveOpenapiFixture(0, { staleFor: 0 });
        const { call, api, actors, path, profile } = fixture;
        const first = yield* call("old", "old");
        expect(first.status).toBe(200);
        expect(yield* body(Schema.Json, first)).toEqual({
          token: "synthetic-live-key",
          stolen: null,
        });
        yield* fixture.publish;
        const changed = yield* call("new", "new");
        expect(changed.status).toBe(200);
        expect(yield* body(Schema.Json, changed)).toEqual({
          token: "synthetic-live-key",
          stolen: null,
        });
        expect((yield* call("old", "old")).status).toBe(404);
        expect((yield* call("evil", "new")).status).toBe(404);
        const tools = yield* api.request(
          actors.owner,
          "GET",
          `${path}/tools?profile=${profile.id}`,
        );
        expect(tools.status).toBe(200);
        const listing = yield* body(
          Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) }),
          tools,
        );
        expect(listing.items.map((tool) => tool.name)).toEqual(["queries.new"]);
      }),
    ),
  );
});
