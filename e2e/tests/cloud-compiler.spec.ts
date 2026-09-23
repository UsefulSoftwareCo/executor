/** Exercise lazy dependency installation through the real Cloud compiler and app runtime. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Browser } from "../support/browser.ts";

layer(HostedLive, { excludeTestServices: true })("Cloud compiler", (it) => {
  it.effect(scenarios.cloudCatalogInstall.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence;
        yield* browser.login(actors.owner);
        for (let iteration = 0; iteration < 3; iteration++) {
          const name = `Axiom browser proof ${randomUUID().slice(0, 8)}`;
          yield* browser.use("Open the real Add App page", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/add`),
          );
          yield* browser.use("Search for Axiom", (page) =>
            page.getByPlaceholder("Search apps…").fill("Axiom"),
          );
          yield* browser.use("Choose the MCP catalog entry", (page) =>
            page.getByRole("button", { name: /Axiom.*MCP/ }).click(),
          );
          yield* browser.use("Name the synthetic app", (page) =>
            page.getByLabel("App name", { exact: true }).fill(name),
          );
          yield* browser.use("Install while page reads run", (page) =>
            page.getByRole("button", { name: "Add app", exact: true }).click(),
          );
          yield* browser.use("Wait for committed setup navigation", (page) =>
            page.waitForURL("**/apps/*?view=accounts"),
          );
          const pathname = yield* browser.use("Read the installed app location", (page) =>
            page.evaluate(() => location.pathname),
          );
          const id = yield* Schema.decodeUnknownEffect(Schema.String)(
            /^\/org\/[^/]+\/apps\/([^/]+)$/.exec(pathname)?.[1],
          );
          const app = yield* body(
            App,
            yield* api.request(
              actors.owner,
              "GET",
              `/api/organizations/${actors.organization.id}/apps/${id}`,
            ),
          );
          expect(app.name).toBe(name);
          yield* Effect.addFinalizer(() =>
            api
              .request(
                actors.owner,
                "DELETE",
                `/api/organizations/${actors.organization.id}/apps/${app.id}`,
              )
              .pipe(Effect.orDie),
          );
          yield* browser.use("Setup follows the committed installation", (page) =>
            page.waitForURL(`**/apps/${app.id}?view=accounts`),
          );
          const timings = yield* browser.use("Record request timing for this install", (page) =>
            page.evaluate(() =>
              performance
                .getEntriesByType("resource")
                .filter((entry) => entry.name.endsWith("/apps/install"))
                .map((entry) => {
                  if (!(entry instanceof PerformanceResourceTiming))
                    throw new Error("Missing resource timing");
                  return {
                    duration: entry.duration,
                    server: entry.serverTiming.map(({ name, description, duration }) => ({
                      name,
                      description,
                      duration,
                    })),
                  };
                }),
            ),
          );
          yield* evidence.json(`catalog-install-${iteration}.json`, timings);
        }
        yield* browser.checkpoint("Axiom reached account setup after real catalog installs");
      }),
    ),
  );
  it.effect(scenarios.cloudCompilerDependencies.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deploy = (source: string, dependencies: Readonly<Record<string, string>>) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
              name: `Dependency proof ${randomUUID().slice(0, 8)}`,
              files: [
                { path: "index.ts", content: source },
                { path: "package.json", content: JSON.stringify({ type: "module", dependencies }) },
              ],
            });
            expect(response.status).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const direct = yield* deploy(
          `
import { defineApp, query, object } from "apps";
import { z } from "zod";
import manifest from "./package.json";
export default defineApp({accounts:{}}, { queries:{
  inspect: query({description:"Check the installed dependency and original manifest",input:object({})},
    async () => ({value:z.string().parse("real-package"),version:manifest.dependencies.zod}))
}});`,
          { zod: "3.25.76" },
        );
        const checked = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/${direct.id}/tools/call`,
          { tool: "queries.inspect", input: {} },
        );
        expect(checked.status).toBe(200);
        expect(checked.body).toEqual({ value: "real-package", version: "3.25.76" });

        const unused = yield* deploy(
          `
import { defineApp, query, object } from "apps";
import manifest from "./package.json";
export default defineApp({accounts:{}},{queries:{
  inspect:query({description:"Read the original declaration",input:object({})},async()=>manifest.dependencies)
}});`,
          { "@executor-fixture/unused-package": "0.0.0-synthetic" },
        );
        const preserved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/${unused.id}/tools/call`,
          { tool: "queries.inspect", input: {} },
        );
        expect(preserved.status).toBe(200);
        expect(preserved.body).toEqual({ "@executor-fixture/unused-package": "0.0.0-synthetic" });
        yield* evidence.json("dependency-proof.json", {
          direct: checked.body,
          unused: preserved.body,
        });
      }),
    ),
  );
});
