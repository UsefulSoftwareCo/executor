import { expect, layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { createProfile } from "../support/profiles.ts";

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.dynamicOnlyApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const dynamicOnly = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Dynamic only ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, dynamicTools, query, object } from "apps";
export default defineApp({ accounts: {} }, {
  dynamicTools: dynamicTools({
    list: async () => [{ name: "queries.ping", description: "Return pong", inputSchema: { type: "object", properties: {} }, readOnly: true }],
    resolve: async name => name === "queries.ping" ? query({ input: object({}) }, async () => "pong") : undefined,
  }),
});
`,
            },
          ],
        });
        expect(dynamicOnly.status).toBe(200);
        const dynamicPath = `${prefix}/${(yield* body(App, dynamicOnly)).id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", dynamicPath).pipe(Effect.orDie),
        );
        const dynamicProfile = yield* createProfile(actors.owner, dynamicPath);
        const dynamicResult = yield* api.request(
          actors.owner,
          "POST",
          `${dynamicPath}/tools/call`,
          {
            profile: dynamicProfile.id,
            tool: "queries.ping",
            input: {},
          },
        );
        expect(dynamicResult.status).toBe(200);
        expect(yield* body(Schema.String, dynamicResult)).toBe("pong");
      }),
    ),
  );
});
