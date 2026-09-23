/** Published framework selection is exercised through the real hosted deployment and UI APIs. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { appPackageFixture } from "../support/app-package.ts";

const files = (dependency: string, direct: string, unused: string) => [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: {
        apps: dependency,
        "direct-fixture": direct,
        "unused-fixture": unused,
        "@modelcontextprotocol/sdk": unused,
        graphql: unused,
      },
    }),
  },
  {
    path: "index.ts",
    content: `import { defineApp, query, mutation, object, defineDatabase, table, string, packageFixture } from "apps";
import { value } from "direct-fixture";
import { mcpOperations } from "apps/mcp";
import { graphqlOperations } from "apps/graphql";
import manifest from "./package.json";
const database = defineDatabase({ notes: table({ text: string() }) });
export default defineApp({ accounts: {}, database }, {
  queries: { dependencies: query({ input: object({}) }, async () => ({ value, mcp: typeof mcpOperations, graphql: typeof graphqlOperations, declared: manifest.dependencies["unused-fixture"] })), version: query({ input: object({}) }, async () => packageFixture),
    notes: query({ input: object({}) }, async ({ db }) => (await db.notes.withIndex("by_creation").collect()).map(row => row.text)) },
  mutations: { save: mutation({ input: object({ text: string() }) }, async ({ db }, input) => { await db.notes.insert(input); return packageFixture; }) }
});`,
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><body><p role="status">Loading</p><script type="module" src="./main.ts"></script></body></html>',
  },
  {
    path: "ui/main.ts",
    content:
      'import { packageFixture } from "apps"; document.querySelector("[role=status]").textContent = packageFixture;',
  },
];

layer(HostedLive, { excludeTestServices: true })("Packaged apps", (it) => {
  it.effect(scenarios.appPackage.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const packages = yield* appPackageFixture;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Package ${randomUUID().slice(0, 8)}`,
          files: files(packages.older, packages.direct, packages.unused),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const call = (tool: string, input: Record<string, string> = {}) =>
          api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, { tool, input });
        expect(yield* body(Schema.String, yield* call("queries.version"))).toBe("older-package");
        expect(
          yield* body(Schema.String, yield* call("mutations.save", { text: "retained row" })),
        ).toBe("older-package");
        const dependencies = yield* call("queries.dependencies");
        expect(dependencies.status).toBe(200);
        expect(dependencies.body).toEqual({
          value: "transitive-package",
          mcp: "function",
          graphql: "function",
          declared: packages.unused,
        });
        const downloaded = yield* packages.requests;
        expect(downloaded["/older.tgz"]).toBe(1);
        expect(downloaded["/direct-fixture.tgz"]).toBe(1);
        expect(downloaded["/transitive-fixture.tgz"]).toBe(1);
        expect(downloaded).not.toHaveProperty("/unused.tgz");
        const rebuilt = yield* saveAndDeploy(actors.owner, `${prefix}/apps/${app.id}`, {
          files: files(packages.older, packages.direct, packages.unused),
        });
        expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(200);
        expect(yield* body(Schema.String, yield* call("queries.version"))).toBe("older-package");
        expect(yield* body(Schema.Array(Schema.String), yield* call("queries.notes"))).toEqual([
          "retained row",
        ]);
        const current = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/source`),
        );
        const rejected = yield* saveAndDeploy(actors.owner, `${prefix}/apps/${app.id}`, {
          files: files(packages.unsupported, packages.direct, packages.unused),
        });
        expect(rejected.status).toBeGreaterThanOrEqual(400);
        expect(yield* body(Schema.String, yield* call("queries.version"))).toBe("older-package");
        expect(
          (yield* body(
            Schema.Struct({ id: Schema.String }),
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/source`),
          )).id,
        ).toBe(current.id);
        const location = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/ui`),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the UI built with the app's own framework", (page) =>
          page.goto(location.url),
        );
        yield* browser.use("The browser uses the older package too", (page) =>
          page.getByRole("status").filter({ hasText: "older-package" }).waitFor(),
        );
      }),
    ),
  );
});
