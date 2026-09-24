/** Revocation must be observed between calls within one execute request. */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { McpClient } from "../support/mcp-client.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { requestGate } from "../support/request-gate.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("In-flight MCP authority", (it) => {
  it.effect(scenarios.patMcpInFlight.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const gate = yield* requestGate;
        const root = `/api/organizations/${actors.organization.id}`;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "In-flight test",
          }),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${root}/apps/deploy`, {
          name: "In-flight authority",
          files: [
            {
              path: "index.ts",
              content: `import {defineApp,query,object} from "apps";
export default defineApp({accounts:{}},{queries:{
wait:query({input:object({})},async ctx=>(await ctx.fetch(${JSON.stringify(`${gate.origin}/wait`)})).json()),
done:query({input:object({})},async ctx=>(await ctx.fetch(${JSON.stringify(`${gate.origin}/done`)})).json())
}});`,
            },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* gate.release;
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
            yield* api.request(actors.owner, "DELETE", `${root}/apps/${app.id}`);
          }).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "in-flight", {
          organization: actors.organization.id,
        });
        const program = yield* client
          .use("Execute two calls across a controlled upstream wait", (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `await tools[${JSON.stringify(app.slug)}].queries.wait({}); return await tools[${JSON.stringify(app.slug)}].queries.done({});`,
                },
              },
              undefined,
              { signal },
            ),
          )
          .pipe(Effect.forkScoped);
        yield* gate.arrived;
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id }))
            .status,
        ).toBe(200);
        yield* gate.release;
        const result = yield* Fiber.join(program);
        const completed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({ ok: Schema.Boolean }),
          }),
        )(result.structuredContent);
        expect(completed.execution.ok).toBe(false);
        expect(yield* gate.completed).toBe(0);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
