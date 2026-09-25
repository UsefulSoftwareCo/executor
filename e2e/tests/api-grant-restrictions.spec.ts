import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { scenarios } from "../test-plan.ts";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Inventory } from "../support/contracts.ts";
import { authorizationFixture } from "../support/authorization.ts";

layer(HostedLive, { excludeTestServices: true })("Shared authorization", (it) => {
  it.effect(scenarios.apiGrantRestrictions.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, oauth, anonymous, prefix, grant, call, addTool } =
          yield* authorizationFixture("api");
        yield* addTool;
        const refreshed = yield* oauth.refresh(grant);
        const headers = {
          authorization: `Bearer ${Redacted.value(refreshed.tokens).access_token}`,
        };
        expect((yield* call("mutations.echo", headers)).status).toBe(200);
        expect((yield* call("mutations.later", headers)).status).toBe(403);
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
            id: grant.grantId,
            policy: { kind: "tools", apps: [], approval: "client" },
          })).status,
        ).toBe(200);
        expect((yield* call("mutations.echo", headers)).status).toBe(403);
        const inventory = yield* body(
          Inventory,
          yield* api.request(anonymous, "GET", `${prefix}/inventory`, undefined, headers),
        );
        expect(inventory.apps).toEqual([]);
        yield* oauth.revoke(refreshed);
        expect((yield* call("mutations.echo", headers)).status).toBe(401);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
