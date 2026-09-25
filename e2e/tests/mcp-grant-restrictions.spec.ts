import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { authorizationFixture } from "../support/authorization.ts";
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
});
layer(HostedLive, { excludeTestServices: true })("Shared authorization", (it) => {
  it.effect(scenarios.liveGrantRestrictions.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, evidence, mcp, app, receipt, hidden, grant, addTool } =
          yield* authorizationFixture("mcp");
        yield* addTool;
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "shared-policy",
        );
        const execute = (code: string) =>
          client.use("Execute under the selected MCP grant", (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
          );
        const [allowed, denied, hiddenCall] = yield* Effect.all(
          [
            execute(
              `return await tools[${JSON.stringify(app.slug)}].mutations.echo({message: "shared policy"})`,
            ),
            execute(
              `return await tools[${JSON.stringify(app.slug)}].mutations.later({message: "denied"})`,
            ),
            execute(
              `return await tools[${JSON.stringify(hidden.app.slug)}].mutations.echo({message: "denied"})`,
            ),
          ],
          { concurrency: 3 },
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Execution)(allowed.structuredContent)).execution,
        ).toEqual({ ok: true, value: { message: "shared policy", receipt } });
        expect(
          (yield* Schema.decodeUnknownEffect(Execution)(denied.structuredContent)).execution.ok,
        ).toBe(false);
        expect(
          (yield* Schema.decodeUnknownEffect(Execution)(hiddenCall.structuredContent)).execution.ok,
        ).toBe(false);
        yield* evidence.step(
          "Deployment changes retain selections and later narrowing affects active clients",
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
                id: grant.grantId,
                policy: { kind: "tools", apps: [], approval: "client" },
              })).status,
            ).toBe(200);
            const revokedTool = yield* execute(
              `return await tools[${JSON.stringify(app.slug)}].mutations.echo({message: "denied"})`,
            );
            expect(
              (yield* Schema.decodeUnknownEffect(Execution)(revokedTool.structuredContent))
                .execution.ok,
            ).toBe(false);
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
