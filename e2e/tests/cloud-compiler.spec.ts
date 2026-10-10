/** Exercise dependency installation and failure recovery through the real Cloud compiler. */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Browser } from "../support/browser.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { appsManifest, appsVersion, withApps } from "../support/apps-release.ts";
import { stalledPackage } from "../support/npm-registry.ts";

layer(HostedLive, { excludeTestServices: true })("Cloud compiler", (it) => {
  it.effect(scenarios.cloudCompilerMemory.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const files = (version: string) => [
          {
            path: "index.ts",
            content: `import { defineApp, query, object, router } from "apps";
export default defineApp({accounts:{}}, {tools: router({
  inspect:query({description:"Read the active build",input:object({})},async()=>${JSON.stringify(version)}),
})});`,
          },
          appsManifest,
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
              content: `import { defineApp, query, object, router } from "apps";
import ts from "typescript";
import * as icons from "lucide-react";
import React from "react";
export default defineApp({accounts:{}}, {tools: router({
  inspect:query({description:"Compile large dependencies",input:object({})},
    async()=>({version:ts.version,icons:Object.keys(icons).length,react:React.version})),
})});`,
            },
            {
              path: "package.json",
              content: JSON.stringify({
                type: "module",
                dependencies: withApps({
                  typescript: "5.9.2",
                  "lucide-react": "0.468.0",
                  react: "19.2.0",
                }),
              }),
            },
          ],
        });
        yield* evidence.json("compiler-memory-response.json", {
          status: exhausted.status,
          body: exhausted.body,
        });
        expect(exhausted.status).toBe(422);
        expect(exhausted.body).toEqual({
          _tag: "BuildMemoryExceeded",
          message:
            "This app's build needed more memory than Executor currently allows. No new deployment was activated.",
          recovery: {
            action:
              "This is a current platform limit, and we plan to raise it. Until then, fewer or smaller dependencies can help the build fit.",
            instructions: expect.stringContaining("Tell the user the build hit the current limit."),
          },
        });
        const retained = yield* body(Deployed, yield* api.request(actors.owner, "GET", path));
        expect(retained.activeDeployment).toBe(original.activeDeployment);
        const live = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "inspect",
          kind: "query",
          input: {},
        });
        expect(live.status).toBe(200);
        expect(live.body).toBe("original");

        yield* browser.login(actors.owner);
        yield* browser.use("Open the failed build's saved source", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${original.id}?view=source`),
        );
        yield* browser.use("Deploy the large build from the dashboard", (page) =>
          page.getByRole("button", { name: "Deploy latest", exact: true }).click(),
        );
        yield* browser.use("Show the compiler memory failure and recovery", (page) =>
          page
            .getByText(
              "This app's build needed more memory than Executor currently allows. No new deployment was activated. This is a current platform limit, and we plan to raise it. Until then, fewer or smaller dependencies can help the build fit.",
              { exact: true },
            )
            .waitFor(),
        );
        yield* browser.checkpoint("Compiler memory failure preserves saved source");

        const invalid = yield* saveAndDeploy(actors.owner, path, {
          files: [{ path: "index.ts", content: "export default = ;" }, appsManifest],
        });
        expect(invalid.status).toBe(422);
        expect(invalid.body).toMatchObject({ _tag: "DeploymentBuildFailed" });
        const recovered = yield* saveAndDeploy(actors.owner, path, { files: files("recovered") });
        expect(recovered.status).toBe(200);
        const { app: updated } = yield* body(Schema.Struct({ app: Deployed }), recovered);
        expect(updated.activeDeployment).not.toBe(original.activeDeployment);
        const working = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "inspect",
          kind: "query",
          input: {},
        });
        expect(working.status).toBe(200);
        expect(working.body).toBe("recovered");
      }),
    ),
  );
  it.effect(scenarios.cloudCompilerUiFiles.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        // Synthetic static files, larger than a typical UI. Embedded in the server entry, they
        // exhausted the compiler's memory; the host serves them as UI assets instead.
        const publicFiles = Array.from({ length: 10 }, (_, chunk) => ({
          path: `ui/public/vendor/chunk-${chunk}.js`,
          content: Array.from(
            { length: 12_000 },
            (_, line) => `export const v${line}="grammar ${chunk} scope ${line} \\"quoted\\"";\n`,
          ).join(""),
        }));
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Large UI ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, router } from "apps";
export default defineApp({accounts:{}}, async (ctx) => ({tools: router({
  inspect:query({description:"List retained files",input:object({})},async()=>ctx.files.map((file)=>file.path)),
})}));`,
            },
            {
              path: "package.json",
              content: JSON.stringify({
                type: "module",
                dependencies: withApps({ react: "19.2.0", "react-dom": "19.2.0" }),
              }),
            },
            {
              path: "ui/index.html",
              content:
                '<!doctype html><html><head><title>Large UI</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
            },
            {
              path: "ui/main.tsx",
              content:
                'import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<p>Ready</p>);\n',
            },
            ...publicFiles,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body).slice(0, 500)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const retained = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/${app.id}/tools/call`,
          {
            tool: "inspect",
            kind: "query",
            input: {},
          },
        );
        expect(retained.status).toBe(200);
        expect(retained.body).toEqual(["index.ts", "package.json"]);
      }),
    ),
  );
  it.effect(
    scenarios.cloudCompilerDeadline.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence;
          const prefix = `/api/organizations/${actors.organization.id}/apps`;
          // The registry starts this package's metadata and never finishes it, so the compiler
          // Worker stays busy and never answers, as a lost compiler isolate does.
          const [duration, stalled] = yield* api
            .request(actors.owner, "POST", `${prefix}/deploy`, {
              name: `Compiler deadline ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, query, object, router } from "apps";
import stalled from "${stalledPackage}";
export default defineApp({accounts:{}}, {tools: router({
  inspect:query({description:"Never compiles",input:object({})},async()=>String(stalled)),
})});`,
                },
                {
                  path: "package.json",
                  content: JSON.stringify({
                    type: "module",
                    dependencies: withApps({ [stalledPackage]: "1.0.0" }),
                  }),
                },
              ],
            })
            .pipe(Effect.timed);
          const elapsed = Duration.toMillis(duration);
          yield* evidence.json("compiler-deadline-response.json", {
            elapsed,
            status: stalled.status,
            body: stalled.body,
          });
          expect(stalled.status, JSON.stringify(stalled.body)).toBe(422);
          expect(stalled.body).toMatchObject({
            _tag: "DeploymentBuildFailed",
            stage: "compile",
            message:
              "App build failed at the compile stage: The compiler did not answer within 50 seconds. No new deployment was activated; deploy again.",
          });
          expect(elapsed).toBeGreaterThanOrEqual(50_000);
          expect(elapsed).toBeLessThan(58_000);
          const listed = yield* api.request(actors.owner, "GET", prefix);
          expect(JSON.stringify(listed.body)).not.toContain("Compiler deadline");
        }),
      ),
    // The deadline itself takes 50 seconds before the response is checked.
    { timeout: 120_000 },
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
                {
                  path: "package.json",
                  content: JSON.stringify({ type: "module", dependencies: withApps(dependencies) }),
                },
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
import { defineApp, query, object, router } from "apps";
import { z } from "zod";
import manifest from "./package.json";
export default defineApp({accounts:{}}, { tools: router({
   inspect: query({description:"Check the installed dependency and original manifest",input:object({})},
    async () => ({value:z.string().parse("real-package"),version:manifest.dependencies.zod})),
 })});`,
          { zod: "3.25.76" },
        );
        const checked = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/${direct.id}/tools/call`,
          { tool: "inspect", kind: "query", input: {} },
        );
        expect(checked.status).toBe(200);
        expect(checked.body).toEqual({ value: "real-package", version: "3.25.76" });

        const unused = yield* deploy(
          `
import { defineApp, query, object, router } from "apps";
import manifest from "./package.json";
export default defineApp({accounts:{}},{tools: router({
  inspect:query({description:"Read the original declaration",input:object({})},async()=>manifest.dependencies),
})});`,
          { "@executor-fixture/unused-package": "0.0.0-synthetic" },
        );
        const preserved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/${unused.id}/tools/call`,
          { tool: "inspect", kind: "query", input: {} },
        );
        expect(preserved.status).toBe(200);
        expect(preserved.body).toEqual(
          withApps({ "@executor-fixture/unused-package": "0.0.0-synthetic" }),
        );

        // A source that declares no apps release is refused before compiling, naming this host's.
        const undeclared = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Undeclared ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({ tools: router({}) }));`,
            },
          ],
        });
        expect(undeclared.status, JSON.stringify(undeclared.body)).toBe(422);
        expect(undeclared.body).toMatchObject({
          _tag: "DeploymentBuildFailed",
          reason: `Add "apps": "${appsVersion}" to package.json dependencies. Every app declares the exact apps version it uses; ${appsVersion} is this host's.`,
        });
        yield* evidence.json("dependency-proof.json", {
          direct: checked.body,
          unused: preserved.body,
        });
      }),
    ),
  );
  it.effect(
    scenarios.cloudCompilerConcurrency.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence;
          const prefix = `/api/organizations/${actors.organization.id}/apps`;
          // Every build installs and bundles React, the heaviest common browser dependency. Builds
          // that arrive together share one compiler isolate's memory; when they ran unbounded,
          // the isolate exceeded its limit and failed every build in flight.
          const deploy = (index: number) =>
            Effect.gen(function* () {
              const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
                name: `Concurrent build ${index} ${randomUUID().slice(0, 8)}`,
                files: [
                  {
                    path: "index.ts",
                    content: `import { defineApp, query, object, router } from "apps";
import { z } from "zod";
export default defineApp({accounts:{}}, {tools: router({
  inspect:query({description:"Read the build",input:object({})},async()=>z.string().parse("build ${index}")),
})});`,
                  },
                  {
                    path: "package.json",
                    content: JSON.stringify({
                      type: "module",
                      dependencies: withApps({
                        zod: "3.25.76",
                        react: "^19.2.0",
                        "react-dom": "^19.2.0",
                      }),
                    }),
                  },
                  {
                    path: "ui/index.html",
                    content:
                      '<!doctype html><html><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
                  },
                  {
                    path: "ui/main.tsx",
                    content: `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")).render(<main>Build ${index}</main>);`,
                  },
                ],
              });
              if (response.status === 200) {
                const app = yield* body(App, response);
                yield* Effect.addFinalizer(() =>
                  api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
                );
              }
              return { index, status: response.status, body: response.body };
            });
          // Several bursts, since Cloudflare can spread a burst over fresh isolates.
          const results = [];
          for (let burst = 0; burst < 4; burst++)
            results.push(
              ...(yield* Effect.all(
                Array.from({ length: 12 }, (_, index) => deploy(burst * 100 + index)),
                { concurrency: "unbounded" },
              )),
            );
          yield* evidence.json("concurrent-builds.json", results);
          expect(results.filter((result) => result.status !== 200)).toEqual([]);
        }),
      ),
    // Four bursts of builds, each of which may wait up to the compiler's 50 second deadline.
    { timeout: 240_000 },
  );
});
