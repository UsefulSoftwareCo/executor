/** Exercise dependency installation and failure recovery through the real Cloud compiler. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Browser } from "../support/browser.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";

layer(HostedLive, { excludeTestServices: true })("Cloud compiler", (it) => {
  it.effect(scenarios.cloudCompilerMemory.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const files = (version: string) => [
          {
            path: "index.ts",
            content: `import { defineApp, query, object } from "apps";
export default defineApp({accounts:{}}, {queries:{
  inspect:query({description:"Read the active build",input:object({})},async()=>${JSON.stringify(version)})
}});`,
          },
        ];
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Memory proof ${randomUUID().slice(0, 8)}`,
          files: files("original"),
        });
        expect(deployed.status).toBe(200);
        const Deployed = Schema.Struct({ ...App.fields, activeDeployment: Schema.String });
        const original = yield* body(Deployed, deployed);
        const path = `${prefix}/${original.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        // Installation and bundling exceed the hosted compiler's memory, not the API's.
        // These are synthetic source files; no production app is used as a fixture.
        const exhausted = yield* saveAndDeploy(actors.owner, path, {
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object } from "apps";
import ts from "typescript";
import * as icons from "lucide-react";
import React from "react";
export default defineApp({accounts:{}}, {queries:{
  inspect:query({description:"Compile large dependencies",input:object({})},
    async()=>({version:ts.version,icons:Object.keys(icons).length,react:React.version}))
}});`,
            },
            {
              path: "package.json",
              content: JSON.stringify({
                type: "module",
                dependencies: {
                  typescript: "5.9.2",
                  "lucide-react": "0.468.0",
                  react: "19.2.0",
                },
              }),
            },
          ],
        });
        yield* evidence.json("compiler-memory-response.json", {
          status: exhausted.status,
          body: exhausted.body,
        });
        const request = (yield* evidence.requests).at(-1);
        if (request === undefined) return yield* Effect.die("Build request evidence missing");
        const trace = yield* telemetry.query(request.traceId).pipe(
          Effect.flatMap((trace) =>
            trace.data.some((row) => row.span.operationName === "runtime.cloud.build")
              ? Effect.succeed(trace)
              : Effect.fail(new Error("The compiler failure trace has not reached the collector")),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
        );
        yield* evidence.json("compiler-memory-trace.json", trace);
        expect(trace.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              span: expect.objectContaining({
                operationName: "runtime.cloud.build",
                tags: expect.objectContaining({
                  "build.stage": "compile",
                  "build.cause": expect.stringContaining("Worker exceeded memory limit"),
                }),
              }),
            }),
          ]),
        );
        expect(exhausted.status).toBe(422);
        expect(exhausted.body).toEqual({ _tag: "BuildMemoryExceeded" });
        const retained = yield* body(Deployed, yield* api.request(actors.owner, "GET", path));
        expect(retained.activeDeployment).toBe(original.activeDeployment);
        const live = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "queries.inspect",
          input: {},
        });
        expect(live.status).toBe(200);
        expect(live.body).toBe("original");

        yield* browser.login(actors.owner);
        yield* browser.use("Open the failed build's saved source", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${original.id}?view=source`),
        );
        yield* browser.use("Deploy the large build from the dashboard", (page) =>
          page.getByRole("button", { name: "Deploy", exact: true }).click(),
        );
        yield* browser.use("Show the compiler memory failure and recovery", (page) =>
          page
            .getByText(
              "Executor ran out of memory while building the app. No new deployment was activated. Review the build's dependencies and memory use before deploying again.",
              { exact: true },
            )
            .waitFor(),
        );
        yield* browser.checkpoint("Compiler memory failure preserves saved source");

        const invalid = yield* saveAndDeploy(actors.owner, path, {
          files: [{ path: "index.ts", content: "export default = ;" }],
        });
        expect(invalid.status).toBe(422);
        expect(invalid.body).toMatchObject({ _tag: "DeploymentBuildFailed" });
        const recovered = yield* saveAndDeploy(actors.owner, path, { files: files("recovered") });
        expect(recovered.status).toBe(200);
        const { app: updated } = yield* body(Schema.Struct({ app: Deployed }), recovered);
        expect(updated.activeDeployment).not.toBe(original.activeDeployment);
        const working = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "queries.inspect",
          input: {},
        });
        expect(working.status).toBe(200);
        expect(working.body).toBe("recovered");
      }),
    ),
  );
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
  it.effect(scenarios.cloudGmailInstall.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors,
          api = yield* Api;
        yield* browser.login(actors.owner);
        yield* browser.use("Open Add app", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/add`),
        );
        yield* browser.use("Find Gmail", (page) =>
          page.getByPlaceholder("Search apps…").fill("Gmail"),
        );
        yield* browser.use("Choose the published Gmail definition", (page) =>
          page.getByRole("button", { name: /Gmail.*OpenAPI/ }).click(),
        );
        yield* browser.checkpoint("Gmail catalog install form");
        yield* browser.use("Install Gmail", (page) =>
          page.getByRole("button", { name: "Add app", exact: true }).click(),
        );
        yield* browser.use("Wait for the installed app", (page) =>
          page.waitForURL("**/apps/*?view=accounts"),
        );
        const pathname = yield* browser.use("Read the installed app location", (page) =>
          page.evaluate(() => location.pathname),
        );
        const id = yield* Schema.decodeUnknownEffect(Schema.String)(
          /^\/org\/[^/]+\/apps\/([^/]+)$/.exec(pathname)?.[1],
        );
        const path = `/api/organizations/${actors.organization.id}/apps/${id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const app = yield* body(
          Schema.Struct({ ...App.fields, activeDeployment: Schema.NonEmptyString }),
          yield* api.request(actors.owner, "GET", path),
        );
        expect(app.name).toBe("Gmail");
        const source = yield* body(
          Schema.Struct({
            files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
          }),
          yield* api.request(actors.owner, "GET", `${path}/source`),
        );
        const operations = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.NonEmptyArray(Schema.Struct({ baseUrl: Schema.String }))),
        )(source.files.find((file) => file.path === "operations.json")?.content);
        for (const operation of operations)
          expect(new URL(operation.baseUrl).origin).toBe("https://gmail.googleapis.com");
        yield* browser.checkpoint("Gmail installed and ready for account setup");
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
