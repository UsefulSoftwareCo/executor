import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { checkAppLoading } from "../support/app-loading.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Local app navigation", (it) => {
  it.effect(scenarios.localAppDetailLoading.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const browser = yield* Browser;
        const target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const name = `Example ${randomUUID().slice(0, 4)}`;
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name,
            files: [
              {
                path: "index.ts",
                content: `
import { defineApp, query, object } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  queries: { hello: query({ description: "A simple greeting", input: object({}) }, async () => "Hello") }
}));`,
              },
            ],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app, deployment } = yield* body(
          Schema.Struct({ app: Resource, deployment: Resource }),
          deployed,
        );
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("Pairing completes before checking app navigation", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        yield* checkAppLoading({
          url: `/apps/${app.id}`,
          name,
          metadata: [`/dashboard/api/live/apps/${app.id}`],
          coldInventory: ["/dashboard/api/live/overview"],
          tools: [`/dashboard/api/live/apps/${app.id}/tools`],
          workspace: [`/api/apps/${app.id}/workspace/display`],
          history: [`/api/apps/${app.id}/history`],
          source: [`/dashboard/api/apps/${app.id}/deployments/${deployment.id}/display`],
        });
      }),
    ),
  );
});
