import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { checkAppLoading } from "../support/app-loading.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("App detail navigation", (it) => {
  for (const [scenario, viewport] of [
    [scenarios.appDetailLoading, { width: 1440, height: 900 }],
    [scenarios.appDetailLoadingMobile, { width: 390, height: 844 }],
  ] as const)
    it.effect(scenario.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors;
          const api = yield* Api;
          const browser = yield* Browser;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Loading example ${randomUUID().slice(0, 8)}`,
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
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
              Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
              Effect.orDie,
            ),
          );
          yield* browser.login(actors.owner);
          const paths = [actors.organization.slug, actors.organization.id].map(
            (reference) => `/api/organizations/${reference}/apps/${app.id}`,
          );
          yield* checkAppLoading({
            viewports: [viewport],
            url: `/org/${actors.organization.slug}/apps/${app.id}`,
            name: app.name,
            metadata: paths,
            overviewInventory: [actors.organization.slug, actors.organization.id].map(
              (reference) => `/api/organizations/${reference}/inventory`,
            ),
            tools: paths.map((path) => `${path}/tools/index`),
            workspace: paths.map((path) => `${path}/workspace/display`),
            history: paths.map((path) => `${path}/history`),
            deployments: paths.map((path) => `${path}/deployments`),
            source: paths.map((path) => `${path}/source/display`),
          });
        }),
      ),
    );
});
