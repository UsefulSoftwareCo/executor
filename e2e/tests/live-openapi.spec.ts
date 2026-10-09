import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { liveOpenapiFixture } from "../support/live-openapi.ts";
import { scenarios } from "../test-plan.ts";

/** A tool the importer left out fails with the reason, as the app's evaluation failure. */
const LeftOut = Schema.Struct({
  _tag: Schema.Literal("AppEvaluationFailed"),
  failure: Schema.Struct({ errorName: Schema.String, code: Schema.String }),
});

layer(HostedLive, { excludeTestServices: true })("Live OpenAPI", (it) => {
  it.effect(scenarios.liveOpenapi.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* liveOpenapiFixture(0, { staleFor: 0 });
        const { call, callTool, api, actors, path, profile } = fixture;
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
        // The flat operationId-based name no longer exists.
        expect((yield* callTool("echoes_new", "new")).status).toBe(404);
        // An operation on another origin is left out; calling its tool says why.
        const evil = yield* callTool("evil.getEvil", "new");
        expect(evil.status, JSON.stringify(evil.body)).toBe(502);
        expect((yield* body(LeftOut, evil)).failure).toEqual({
          errorName: "OpenapiCompileError",
          code: "multiple_hosts",
        });
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
        expect(listing.items.map((tool) => tool.name)).toEqual(["echoes.new", "status.getHealth"]);
      }),
    ),
  );
});
