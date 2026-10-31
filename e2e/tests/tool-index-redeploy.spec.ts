/** A deploy reaches an app's MCP tools without relinking its accounts, in the same execute and the next. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Inventory, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { linkedAccountIds, connectionsPath } from "../support/app-accounts.ts";
import { managementApp } from "../support/management-app.ts";
import { McpClient } from "../support/mcp-client.ts";

const source = (
  tools: string,
  health = "healthy",
) => `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Redeploy fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const ping=query({description:"Ping the service",input:object({})},async()=>"pong");
const diagnose=query({description:"Diagnose the service",input:object({})},async()=>${JSON.stringify(health)});
export default defineApp({user: { accounts:{service} }}, async () => ({ tools: router({ ${tools} }) }));`;
const accountFree = `import {defineApp,query,object,router} from "apps";
export default defineApp({}, async () => ({ tools: router({ ping: query({input:object({})},async()=>"pong") }) }));`;
const Deployed = Schema.Struct({ ...App.fields, activeVersion: Schema.String });
const Executed = Schema.Struct({
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(
      Schema.Struct({
        kind: Schema.String,
        message: Schema.String,
        suggestions: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
    toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, outcome: Schema.String })),
  }),
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
});
const Paths = Schema.Array(Schema.String);

layer(HostedLive, { excludeTestServices: true })("Tool index after redeploy", (it) => {
  it.effect(scenarios.toolIndexRedeploy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const created: string[] = [];
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const id of created)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${id}`);
            for (const id of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${id}`);
          }).pipe(Effect.orDie),
        );
        const deploy = (name: string, content: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files: [{ path: "index.ts", content }, appsManifest],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(Deployed, response);
            created.push(app.id);
            return app;
          });
        const app = yield* deploy(`Redeploy ${randomUUID().slice(0, 8)}`, source("ping")),
          path = `${prefix}/apps/${app.id}`;
        // Connecting an account from the app links it to the app.
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {
            destination: { kind: "personal" },
          }),
        );
        const submitted = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "key", label: "Redeploy account", fields: { token: "synthetic-redeploy" } },
        );
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
        const account = (yield* body(Resource, submitted)).id;
        accounts.push(account);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);

        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Redeploy",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "tool-index-redeploy", {
          organization: actors.organization.id,
        });
        const execute = (label: string, code: string) =>
          client
            .use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Executed)(result.structuredContent),
              ),
            );
        const slug = JSON.stringify(app.slug);
        const tools = `tools[${slug}]`;
        const listed = (label: string) =>
          execute(
            label,
            `const found = await tools.search({ query: "service", namespace: ${slug} });
return found.items.map((item) => item.path.split(".").at(-1)).sort();`,
          ).pipe(
            Effect.flatMap((result) => Schema.decodeUnknownEffect(Paths)(result.execution.value)),
          );
        expect(yield* listed("Search before the redeploy")).toEqual(["ping"]);

        // A deploy is a new version for every caller: the next execute lists and calls the new
        // tool without relinking the account or a reconcile.
        const redeployed = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: [{ path: "index.ts", content: source("ping, diagnose") }, appsManifest],
        });
        expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
        const { app: live } = yield* body(Schema.Struct({ app: Deployed }), redeployed);
        expect(yield* listed("Search after the redeploy")).toEqual(["diagnose", "ping"]);
        const called = yield* execute("Call the new tool", `return await ${tools}.diagnose({});`);
        expect(called.execution.value, JSON.stringify(called)).toBe("healthy");
        // The deploy kept the link.
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);

        // The Executor app is provisioned with the member's key linked to it.
        yield* managementApp(actors.owner);
        const executor = "const executor = tools.executor;";
        const organization = { organization: actors.organization.id };
        const deployFrom = (content: string) =>
          `await executor.appManagement.deploy({ path: ${JSON.stringify({ ...organization, app: app.id })}, body: { files: ${JSON.stringify([{ path: "index.ts", content }, appsManifest])} } })`;

        // Deploying and calling an existing tool in one execute: the program loaded the app
        // before the deploy, and the call still runs on the version the program just made.
        const changed = yield* execute(
          "Deploy and call a changed tool in one execute",
          `${executor}
const deployed = ${deployFrom(source("ping, diagnose", "recovered"))};
return { version: deployed.app.activeVersion, health: await ${tools}.diagnose({}) };`,
        );
        expect(changed.execution.error, JSON.stringify(changed)).toBeUndefined();
        expect(changed.execution.toolCalls).toEqual([
          expect.objectContaining({ outcome: "success" }),
          expect.objectContaining({ outcome: "success" }),
        ]);
        const { version: recovered, health } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ version: Schema.String, health: Schema.String }),
        )(changed.execution.value);
        expect(recovered).not.toBe(live.activeVersion);
        expect(health).toBe("recovered");
        const nextChanged = yield* execute(
          "Call the changed tool in the next execute",
          `return await ${tools}.diagnose({});`,
        );
        expect(nextChanged.execution.value, JSON.stringify(nextChanged)).toBe("recovered");

        // A tool the deploy added is not in the program's listing of the app, so the program
        // names the version it listed and the next execute instead of a removed tool.
        const sameProgram = yield* execute(
          "Deploy and call the new tool in one execute",
          `${executor}
${deployFrom(source("ping, diagnose, status: ping", "recovered"))};
return await ${tools}.status({});`,
        );
        expect(sameProgram.execution.toolCalls).toEqual([
          expect.objectContaining({ outcome: "success" }),
        ]);
        expect(sameProgram.execution.error?.kind).toBe("UnknownTool");
        expect(sameProgram.execution.error?.suggestions).toEqual([
          `This execute loaded '${app.slug}' from version ${recovered} when it first reached the app. If the app was deployed after that, call its new tools in a new execute. If the tool was added to the service behind the app, Executor is checking the app for new tools now; they appear within a few minutes, so call it again in a new execute. Otherwise use search to find the app's tools.`,
        ]);
        const nextProgram = yield* execute(
          "Call the new tool in the next execute",
          `return await ${tools}.status({});`,
        );
        expect(nextProgram.execution.value, JSON.stringify(nextProgram)).toBe("pong");

        // An app created in the same execute did not exist when its apps were listed.
        const createdSlug = `created-${randomUUID().slice(0, 8)}`;
        const creating = yield* execute(
          "Create an app and call it in one execute",
          `${executor}
await executor.apps.deploy({ path: ${JSON.stringify(organization)}, body: { name: ${JSON.stringify(createdSlug)}, files: ${JSON.stringify([{ path: "index.ts", content: accountFree }, appsManifest])} } });
return await tools[${JSON.stringify(createdSlug)}].ping({});`,
        );
        const inventory = yield* body(
          Inventory,
          yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
        );
        const createdApp = inventory.apps.find((candidate) => candidate.slug === createdSlug);
        if (createdApp === undefined) return yield* Effect.die(`Missing app ${createdSlug}`);
        created.push(createdApp.id);
        expect(creating.execution.error?.kind).toBe("UnknownTool");
        expect(creating.execution.error?.suggestions).toEqual([
          `No app '${createdSlug}' existed when this execute started. If it was created or deployed during this execute, call it in a new execute. Otherwise use search to find available tools.`,
        ]);

        // A new app that needs an account has no tools until an account is linked to it. Searching
        // it by name says so; a search of everything stays quiet about it.
        const fresh = yield* deploy(`Fresh ${randomUUID().slice(0, 8)}`, source("ping"));
        const named = yield* execute(
          "Search a new account app by name",
          `return await tools.search({ query: "service", namespace: ${JSON.stringify(fresh.slug)} });`,
        );
        expect(named.execution.value).toMatchObject({ items: [] });
        expect(named.unavailableApps).toEqual([
          expect.objectContaining({
            app: fresh.id,
            reason: expect.stringContaining("AppAccountRequired"),
          }),
        ]);
        const everything = yield* execute(
          "Search every app",
          `return (await tools.search({ query: "Ping the service" })).items.length;`,
        );
        expect(everything.unavailableApps.map((entry) => entry.app)).not.toContain(fresh.id);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
