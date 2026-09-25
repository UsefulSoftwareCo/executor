import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Inventory } from "../support/contracts.ts";
import { authorizationFixture } from "../support/authorization.ts";

const Tools = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
layer(HostedLive, { excludeTestServices: true })("Shared authorization", (it) => {
  it.effect(scenarios.sharedAuthorization.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, evidence, anonymous, app, receipt, hidden, prefix, oauth, headers, call } =
          yield* authorizationFixture("api");
        const mcpGrant = yield* oauth.authorize;
        yield* evidence.step(
          "The API enforces the same selected-app and selected-tool policy",
          Effect.gen(function* () {
            const inventory = yield* body(
              Inventory,
              yield* api.request(anonymous, "GET", `${prefix}/inventory`, undefined, headers),
            );
            expect(inventory.apps.map((item) => item.id)).toEqual([app.id]);
            expect(inventory.accounts).toEqual([]);
            const tools = yield* api.request(
              anonymous,
              "GET",
              `${prefix}/apps/${app.id}/tools`,
              undefined,
              headers,
            );
            expect(tools.status).toBe(200);
            expect((yield* body(Tools, tools)).items.map((item) => item.name)).toEqual([
              "mutations.echo",
            ]);
            const response = yield* call("mutations.echo");
            expect(response.status).toBe(200);
            expect(response.body).toEqual({ message: "shared policy", receipt });
            yield* Effect.forEach(
              [
                `${prefix}/apps/${hidden.app.id}`,
                `${prefix}/apps/${hidden.app.id}/tools`,
                `${prefix}/apps/${app.id}/source`,
                `${prefix}/apps/${app.id}/deployments`,
              ],
              (path) =>
                Effect.gen(function* () {
                  expect(
                    (yield* api.request(anonymous, "GET", path, undefined, headers)).status,
                  ).toBe(403);
                }),
              { concurrency: 4, discard: true },
            );
            expect(
              (yield* api.request(
                anonymous,
                "POST",
                `${prefix}/apps/${app.id}/data/mutate`,
                { name: "echo", input: { message: "bypass" } },
                headers,
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(
                anonymous,
                "POST",
                `${prefix}/apps/deploy`,
                { name: "Denied", files: [{ path: "index.ts", content: "" }] },
                headers,
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(anonymous, "GET", `${prefix}/inventory`, undefined, {
                authorization: `Bearer ${Redacted.value(mcpGrant.tokens).access_token}`,
              })).status,
            ).toBe(401);
            expect((yield* api.request(anonymous, "GET", "/mcp", undefined, headers)).status).toBe(
              401,
            );
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
