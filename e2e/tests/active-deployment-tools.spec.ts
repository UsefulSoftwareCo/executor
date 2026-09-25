import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const Catalog = Schema.Struct({
  deployment: Schema.String,
  items: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
});
const source = (version: number) => [
  {
    path: "index.ts",
    content: `
import { defineApp, mutation, object } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({accounts:{}}, async()=>({mutations:{
  guarded: mutation({input:object({})${version === 2 ? ",approval:always()" : ""}},async()=>({version:${version}})),
  review: mutation({input:object({}),approval:always()},async()=>({version:${version}}))
  ${version === 1 ? ",retired:mutation({input:object({})},async()=>({version:1}))" : ""}
}}));`,
  },
];
const fixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Deployment policy ${randomUUID().slice(0, 8)}`,
    files: source(1),
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed),
    path = `${prefix}/apps/${app.id}`;
  yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
  const access = yield* body(
    Schema.Struct({ revision: Schema.String }),
    yield* api.request(actors.owner, "GET", `${path}/access`),
  );
  expect(
    (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
      revision: access.revision,
      audience: { kind: "everyone" },
    })).status,
  ).toBe(200);
  const catalog = yield* body(Catalog, yield* api.request(actors.member, "GET", `${path}/tools`));
  const promote = api
    .request(actors.owner, "POST", `${path}/deploy`, { files: source(2) })
    .pipe(
      Effect.tap((response) =>
        Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
      ),
    );
  return { api, actors, app, path, catalog, promote };
});
layer(HostedLive, { excludeTestServices: true })("Active deployment policy", (it) => {
  it.effect(scenarios.activeDeploymentTools.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, app, path, catalog, promote } = yield* fixture;
        const browser = yield* Browser,
          oauth = yield* McpOAuth;
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorizeApi;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
            id: grant.grantId,
            policy: {
              kind: "tools",
              apps: [
                {
                  app: app.id,
                  tools: { kind: "selected", names: ["mutations.guarded", "mutations.retired"] },
                },
              ],
              approval: "client",
            },
          })).status,
        ).toBe(200);
        const anonymous = yield* api.session();
        const callers = [
          { session: actors.member, headers: {} },
          {
            session: anonymous,
            headers: { authorization: `Bearer ${Redacted.value(grant.tokens).access_token}` },
          },
        ];
        for (const caller of callers) {
          const result = yield* api.request(
            caller.session,
            "POST",
            `${path}/tools/call`,
            { tool: "mutations.guarded", input: {}, deployment: catalog.deployment },
            caller.headers,
          );
          expect(result.status).toBe(200);
          expect(result.body).toEqual({ version: 1 });
        }
        yield* promote;
        for (const caller of callers) {
          const retired = yield* api.request(
            caller.session,
            "POST",
            `${path}/tools/call`,
            { tool: "mutations.guarded", input: {}, deployment: catalog.deployment },
            caller.headers,
          );
          expect(
            retired.status,
            "A retired build must not bypass the newly required approval",
          ).toBe(404);
          expect(retired.body).toMatchObject({ _tag: "DeploymentNotFound" });
          for (const endpoint of ["tools", "tools/index", "tools/mutations.guarded"]) {
            const stale = yield* api.request(
              caller.session,
              "GET",
              `${path}/${endpoint}?deployment=${catalog.deployment}`,
              undefined,
              caller.headers,
            );
            expect(stale.status, endpoint).toBe(404);
            expect(stale.body, endpoint).toMatchObject({ _tag: "DeploymentNotFound" });
          }
          const current = yield* body(
            Catalog,
            yield* api.request(caller.session, "GET", `${path}/tools`, undefined, caller.headers),
          );
          expect(current.deployment).not.toBe(catalog.deployment);
          expect(current.items.map((tool) => tool.name)).not.toContain("mutations.retired");
          for (const deployment of [undefined, current.deployment]) {
            for (const endpoint of ["tools/index", "tools/mutations.guarded"]) {
              const query = deployment === undefined ? "" : `?deployment=${deployment}`;
              const inspected = yield* api.request(
                caller.session,
                "GET",
                `${path}/${endpoint}${query}`,
                undefined,
                caller.headers,
              );
              expect(inspected.status, endpoint).toBe(200);
              expect(inspected.body, endpoint).toMatchObject({ deployment: current.deployment });
            }
            const result = yield* api.request(
              caller.session,
              "POST",
              `${path}/tools/call`,
              {
                tool: "mutations.guarded",
                input: {},
                ...(deployment === undefined ? {} : { deployment }),
              },
              caller.headers,
            );
            expect(result.status).toBe(409);
            expect(result.body).toMatchObject({ _tag: "ToolApprovalRequired" });
          }
          expect(
            (yield* api.request(
              caller.session,
              "POST",
              `${path}/tools/call`,
              { tool: "mutations.retired", input: {} },
              caller.headers,
            )).status,
          ).toBe(404);
        }
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );
  it.effect(scenarios.activeDeploymentResume.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, app, path, promote } = yield* fixture;
        const browser = yield* Browser,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "deployment-review",
        );
        const execute = () =>
          client.use("Start a tool approval", (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].mutations.review({})`,
                },
              },
              undefined,
              { signal },
            ),
          );
        const pending = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* execute()).structuredContent,
        );
        const revoked = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* execute()).structuredContent,
        );
        const raced = yield* client.use(
          "Pause before another new call in the same MCP catalog",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `await tools[${JSON.stringify(app.slug)}].mutations.review({}); return await tools[${JSON.stringify(app.slug)}].mutations.guarded({})`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const racedPending = yield* Schema.decodeUnknownEffect(Pending)(raced.structuredContent);
        yield* promote;
        const resume = (requestId: string) =>
          client.use("Resume a pinned approval", (client, signal) =>
            client.callTool(
              { name: "resume", arguments: { requestId, response: { action: "accept" } } },
              undefined,
              { signal },
            ),
          );
        const resumed = yield* Schema.decodeUnknownEffect(Completed)(
          (yield* resume(pending.requestId)).structuredContent,
        );
        expect(resumed.execution).toEqual({ ok: true, value: { version: 1 } });
        const racedResult = yield* Schema.decodeUnknownEffect(Completed)(
          (yield* resume(racedPending.requestId)).structuredContent,
        );
        expect(
          racedResult.execution.ok,
          "A catalog pin cannot authorize another new call after promotion",
        ).toBe(false);
        const fresh = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* execute()).structuredContent,
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(
            (yield* resume(fresh.requestId)).structuredContent,
          )).execution,
        ).toEqual({ ok: true, value: { version: 2 } });
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
            id: grant.grantId,
            policy: {
              kind: "tools",
              apps: [{ app: app.id, tools: { kind: "selected", names: ["mutations.guarded"] } }],
              approval: "client",
            },
          })).status,
        ).toBe(200);
        const denied = yield* resume(revoked.requestId);
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(denied.structuredContent)).execution.ok,
        ).toBe(false);
        expect((yield* api.request(actors.owner, "GET", `${path}/tools`)).status).toBe(200);
      }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
