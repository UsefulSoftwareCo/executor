import { saveAndDeploy } from "../support/app-authoring.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { Target } from "../support/platform.ts";

const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  activeDeployment: Schema.String,
  accounts: Schema.Record(Schema.String, Schema.String),
});
const Inventory = Schema.Struct({
  apps: Schema.Array(App),
  accounts: Schema.Array(
    Schema.Struct({ id: Schema.String, method: Schema.String, label: Schema.String }),
  ),
});
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Identity = Schema.Struct({ organization: Schema.String, role: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Executor API-key account", (it) => {
  it.effect(scenarios.executorKeyAccount.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const evidence = yield* Evidence,
          target = yield* Target,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const read = (actor: Session) =>
          api.request(actor, "GET", `${prefix}/inventory`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) => body(Inventory, response)),
          );
        const initialReads = yield* Effect.forEach([0, 1, 2, 3], () => read(actors.owner), {
          concurrency: 4,
        });
        const initial = initialReads[0];
        if (initial === undefined)
          return yield* Effect.fail(new Error("Missing initial inventory"));
        const nativeKeys = yield* body(
          Schema.Struct({
            apiKeys: Schema.Array(Schema.Struct({ name: Schema.NullOr(Schema.String) })),
          }),
          yield* api.request(actors.owner, "GET", "/api/auth/api-key/list"),
        );
        expect(nativeKeys.apiKeys.filter((key) => key.name === "Executor app")).toHaveLength(1);
        const app = initial.apps.find((app) => app.name === "Executor");
        if (app === undefined || app.accounts.service === undefined)
          return yield* Effect.fail(new Error("Executor is not connected"));
        const accountId = app.accounts.service;
        expect(initial.accounts.find((account) => account.id === accountId)?.method).toBe("apiKey");
        const call = (actor: Session) =>
          api.request(actor, "POST", `${prefix}/apps/${app.id}/tools/call`, {
            tool: "queries.context_get",
            input: {},
          });
        yield* evidence.step(
          "Repeated upserts preserve the account identity and edited label",
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/accounts/${accountId}`, {
                label: "My Executor key",
              })).status,
            ).toBe(200);
            const inventories = yield* Effect.forEach([0, 1, 2, 3], () => read(actors.owner), {
              concurrency: 4,
            });
            for (const inventory of inventories) {
              expect(inventory.apps.find((item) => item.id === app.id)?.accounts.service).toBe(
                accountId,
              );
              expect(
                inventory.accounts
                  .filter((account) => account.method === "apiKey")
                  .map((account) => account.id),
              ).toEqual([accountId]);
              expect(inventory.accounts.find((account) => account.id === accountId)?.label).toBe(
                "My Executor key",
              );
            }
            const response = yield* call(actors.owner);
            expect(response.status).toBe(200);
            expect(yield* body(Identity, response)).toEqual({
              organization: actors.organization.id,
              role: "owner",
            });
          }),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the Executor Accounts tab", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("The saved API-key account is selected", (page) =>
          page
            .getByRole("link", { name: "My Executor key", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Selected saved Executor API key account");
        yield* browser.use("Close the dashboard before checking saved selections", (page) =>
          page.goto("about:blank"),
        );
        yield* evidence.step(
          "Personal managed keys never rebind the shared app on another member login",
          Effect.gen(function* () {
            const admin = yield* read(actors.admin);
            const selected = admin.apps.find((item) => item.id === app.id)?.accounts.service;
            expect(selected).toBeUndefined();
            expect(admin.accounts.filter((account) => account.method === "apiKey")).toHaveLength(1);
            expect(admin.accounts.some((account) => account.id === accountId)).toBe(false);
            expect((yield* body(Identity, yield* call(actors.owner))).role).toBe("owner");
            expect(
              (yield* read(actors.member)).apps.find((item) => item.id === app.id)?.accounts
                .service,
            ).toBeUndefined();
            expect((yield* call(actors.member)).status).toBe(403);
            yield* read(actors.owner);
          }),
        );
        yield* evidence.step(
          "Explicit account selections are preserved",
          Effect.gen(function* () {
            const connection = yield* body(
              Schema.Struct({ id: Schema.String }),
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "service",
              }),
            );
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              {
                method: "apiKey",
                label: "Manual key",
                fields: { token: "synthetic-manual-key", organization: actors.organization.id },
              },
            );
            expect(saved.status).toBe(200);
            const manual = yield* body(Schema.Struct({ id: Schema.String }), saved);
            expect(
              (yield* read(actors.owner)).apps.find((item) => item.id === app.id)?.accounts.service,
            ).toBe(manual.id);
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/accounts`, {
                accounts: { service: accountId },
              })).status,
            ).toBe(200);
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${manual.id}`))
                .status,
            ).toBe(200);
          }),
        );
        yield* evidence.step(
          "An untouched unconfigured default can adopt the API key",
          Effect.gen(function* () {
            const installed = yield* api.request(actors.owner, "POST", `${prefix}/apps/install`, {
              entry: `${target.metadata.origin}/openapi.json`,
              name: "Executor OAuth fixture",
            });
            expect(installed.status).toBe(200);
            const imported = yield* body(App, installed);
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `${prefix}/apps/${imported.id}`)
                .pipe(Effect.asVoid, Effect.orDie),
            );
            const source = yield* body(
              Source,
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${imported.id}/source`),
            );
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/accounts`, {
                accounts: {},
              })).status,
            ).toBe(200);
            expect(
              (yield* saveAndDeploy(actors.owner, `${prefix}/apps/${app.id}`, {
                files: source.files,
              })).status,
            ).toBe(200);
            expect(
              (yield* read(actors.owner)).apps.find((item) => item.id === app.id)?.accounts.service,
            ).toBe(accountId);
            expect((yield* call(actors.owner)).status).toBe(200);
          }),
        );
        yield* evidence.step(
          "Edited source is preserved",
          Effect.gen(function* () {
            const original = yield* body(
              Source,
              yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/source`),
            );
            const files = original.files.map((file) =>
              file.path === "index.ts"
                ? { ...file, content: file.content + "\n// User customization\n" }
                : file,
            );
            const { app: edited } = yield* body(
              Schema.Struct({ app: App }),
              yield* saveAndDeploy(actors.owner, `${prefix}/apps/${app.id}`, {
                files,
              }),
            );
            expect(
              (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/accounts`, {
                accounts: {},
              })).status,
            ).toBe(200);
            expect(
              (yield* read(actors.owner)).apps.find((item) => item.id === app.id)?.accounts,
            ).toEqual({});
            expect(
              (yield* body(
                App,
                yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}`),
              )).activeDeployment,
            ).toBe(edited.activeDeployment);
            expect(
              (yield* saveAndDeploy(actors.owner, `${prefix}/apps/${app.id}`, {
                files: original.files,
              })).status,
            ).toBe(200);
            yield* read(actors.owner);
          }),
        );
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "executor-key",
        );
        const called = yield* client.use(
          "Run the ordinary Executor OpenAPI app through MCP",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].queries.context_get({});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const completed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({ ok: Schema.Literal(true), value: Identity }),
          }),
        )(called.structuredContent);
        expect(completed.execution.value).toEqual({
          organization: actors.organization.id,
          role: "owner",
        });
        yield* oauth.revoke(grant);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
