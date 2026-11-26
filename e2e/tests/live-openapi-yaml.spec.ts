import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { openapiYamlFixture } from "../support/openapi-yaml.ts";
import { scenarios } from "../test-plan.ts";

const Refusal = Schema.Struct({
  _tag: Schema.String,
  failure: Schema.Struct({ errorName: Schema.String, code: Schema.String }),
});
const Listing = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Json })),
});

layer(HostedLive, { excludeTestServices: true })("Live OpenAPI YAML", (it) => {
  it.effect(scenarios.liveOpenapiYaml.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* openapiYamlFixture;

        const aliased = yield* fixture.deploy("aliased");
        const listed = yield* aliased.tools;
        expect(listed.status).toBe(200);
        const tools = (yield* body(Listing, listed)).items;
        expect(tools.map((tool) => tool.name).sort()).toEqual(["items.getItem", "items.listItems"]);
        for (const tool of tools)
          expect(tool.inputSchema).toMatchObject({
            properties: {
              query: { properties: { limit: { type: "integer", minimum: 1 } } },
            },
          });

        const bomb = yield* fixture.deploy("bomb");
        const refused = yield* bomb.tools;
        expect(refused.status).toBe(502);
        expect(yield* body(Refusal, refused)).toMatchObject({
          _tag: "AppEvaluationFailed",
          failure: { errorName: "OpenapiError", code: "invalid_definition" },
        });
      }),
    ),
  );
});
