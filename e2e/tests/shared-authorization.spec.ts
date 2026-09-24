import { saveAndDeploy } from "../support/app-authoring.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { deployMcpApp } from "../support/mcp-app.ts";
import { Inventory } from "../support/contracts.ts";

const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
});
const Tools = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });

const authorizationFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    browser = yield* Browser,
    evidence = yield* Evidence;
  const oauth = yield* McpOAuth,
    mcp = yield* McpClient;
  const anonymous = yield* api.session();
  const [{ app, receipt }, hidden] = yield* Effect.all([deployMcpApp, deployMcpApp], {
    concurrency: 2,
  });
  const prefix = `/api/organizations/${actors.organization.id}`;
  yield* browser.login(actors.owner);
  const apiGrant = yield* evidence.step(
    "Authorize the API audience through real browser consent",
    oauth.authorizeApi,
  );
  const mcpGrant = yield* evidence.step("Authorize the MCP audience separately", oauth.authorize);
  const policy = {
    kind: "tools",
    apps: [{ app: app.id, tools: { kind: "selected", names: ["mutations.echo"] } }],
    approval: "client",
  };
  yield* Effect.forEach(
    [apiGrant, mcpGrant],
    (grant) =>
      Effect.gen(function* () {
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
            id: grant.grantId,
            policy,
          })).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
            id: grant.grantId,
            policy: { ...policy, apps: [{ app: app.id, tools: { kind: "all" } }] },
          })).status,
        ).toBe(403);
      }),
    { concurrency: 2, discard: true },
  );
  const headers = { authorization: `Bearer ${Redacted.value(apiGrant.tokens).access_token}` };
  const call = (tool: string, token = headers) =>
    api.request(
      anonymous,
      "POST",
      `${prefix}/apps/${app.id}/tools/call`,
      { tool, input: { message: "shared policy" } },
      token,
    );
  const addTool = evidence.step(
    "Adding a tool never expands an exact selection",
    Effect.gen(function* () {
      const updated = yield* saveAndDeploy(actors.owner, `${prefix}/apps/${app.id}`, {
        files: [
          {
            path: "index.ts",
            content: `
import { defineApp, mutation, object, string } from "apps";
export default defineApp({ accounts: {} }, async () => ({  mutations: {
  echo: mutation({ description: "Allowed echo", input: object({ message: string() }) }, async (_, input) => ({ message: input.message, receipt: ${JSON.stringify(receipt)} })),
  later: mutation({ description: "Added after consent", input: object({ message: string() }) }, async () => ({ forbidden: "later" }))
} }));`,
          },
        ],
      });
      expect(updated.status).toBe(200);
      const ownerTools = yield* body(
        Tools,
        yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/tools`),
      );
      expect(ownerTools.items.map((item) => item.name)).toContain("mutations.later");
      const selectedTools = yield* body(
        Tools,
        yield* api.request(anonymous, "GET", `${prefix}/apps/${app.id}/tools`, undefined, headers),
      );
      expect(selectedTools.items.map((item) => item.name)).toEqual(["mutations.echo"]);
      expect((yield* call("mutations.later")).status).toBe(403);
    }),
  );
  return {
    api,
    actors,
    evidence,
    oauth,
    mcp,
    anonymous,
    app,
    receipt,
    hidden,
    prefix,
    apiGrant,
    mcpGrant,
    headers,
    call,
    addTool,
  };
});

layer(HostedLive, { excludeTestServices: true })("Shared authorization", (it) => {
  it.effect(scenarios.sharedAuthorization.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          evidence,
          anonymous,
          app,
          receipt,
          hidden,
          prefix,
          mcpGrant,
          headers,
          call,
          addTool,
        } = yield* authorizationFixture;
        yield* evidence.step(
          "The API enforces the same selected-app and selected-tool policy",
          Effect.gen(function* () {
            const inventory = yield* body(
              Inventory,
              yield* api.request(anonymous, "GET", `${prefix}/inventory`, undefined, headers),
            );
            expect(inventory.apps.map((item) => item.id)).toEqual([app.id]);
            expect(inventory.accounts).toEqual([]);
            const tools = yield* api.request(
              anonymous,
              "GET",
              `${prefix}/apps/${app.id}/tools`,
              undefined,
              headers,
            );
            expect(tools.status).toBe(200);
            expect((yield* body(Tools, tools)).items.map((item) => item.name)).toEqual([
              "mutations.echo",
            ]);
            const response = yield* call("mutations.echo");
            expect(response.status).toBe(200);
            expect(response.body).toEqual({ message: "shared policy", receipt });
            yield* Effect.forEach(
              [
                `${prefix}/apps/${hidden.app.id}`,
                `${prefix}/apps/${hidden.app.id}/tools`,
                `${prefix}/apps/${app.id}/source`,
                `${prefix}/apps/${app.id}/deployments`,
              ],
              (path) =>
                Effect.gen(function* () {
                  expect(
                    (yield* api.request(anonymous, "GET", path, undefined, headers)).status,
                  ).toBe(403);
                }),
              { concurrency: 4, discard: true },
            );
            expect(
              (yield* api.request(
                anonymous,
                "POST",
                `${prefix}/apps/${app.id}/data/mutate`,
                { name: "echo", input: { message: "bypass" } },
                headers,
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(
                anonymous,
                "POST",
                `${prefix}/apps/deploy`,
                { name: "Denied", files: [{ path: "index.ts", content: "" }] },
                headers,
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(anonymous, "GET", `${prefix}/inventory`, undefined, {
                authorization: `Bearer ${Redacted.value(mcpGrant.tokens).access_token}`,
              })).status,
            ).toBe(401);
            expect((yield* api.request(anonymous, "GET", "/mcp", undefined, headers)).status).toBe(
              401,
            );
          }),
        );
        yield* addTool;
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
  it.effect(scenarios.liveGrantRestrictions.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          evidence,
          oauth,
          mcp,
          anonymous,
          app,
          receipt,
          hidden,
          prefix,
          apiGrant,
          mcpGrant,
          call,
          addTool,
        } = yield* authorizationFixture;
        yield* addTool;
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(mcpGrant.tokens).access_token),
          "shared-policy",
        );
        const execute = (code: string) =>
          client.use("Execute under the selected MCP grant", (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
          );
        const [allowed, denied, hiddenCall] = yield* Effect.all(
          [
            execute(
              `return await tools[${JSON.stringify(app.slug)}].mutations.echo({message: "shared policy"})`,
            ),
            execute(
              `return await tools[${JSON.stringify(app.slug)}].mutations.later({message: "denied"})`,
            ),
            execute(
              `return await tools[${JSON.stringify(hidden.app.slug)}].mutations.echo({message: "denied"})`,
            ),
          ],
          { concurrency: 3 },
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Execution)(allowed.structuredContent)).execution,
        ).toEqual({ ok: true, value: { message: "shared policy", receipt } });
        expect(
          (yield* Schema.decodeUnknownEffect(Execution)(denied.structuredContent)).execution.ok,
        ).toBe(false);
        expect(
          (yield* Schema.decodeUnknownEffect(Execution)(hiddenCall.structuredContent)).execution.ok,
        ).toBe(false);
        yield* evidence.step(
          "Refresh retains restrictions and later narrowing affects active clients",
          Effect.gen(function* () {
            const refreshed = yield* oauth.refresh(apiGrant);
            const refreshedHeaders = {
              authorization: `Bearer ${Redacted.value(refreshed.tokens).access_token}`,
            };
            expect((yield* call("mutations.echo", refreshedHeaders)).status).toBe(200);
            expect((yield* call("mutations.later", refreshedHeaders)).status).toBe(403);
            yield* Effect.forEach(
              [apiGrant, mcpGrant],
              (grant) =>
                Effect.gen(function* () {
                  expect(
                    (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
                      id: grant.grantId,
                      policy: { kind: "tools", apps: [], approval: "client" },
                    })).status,
                  ).toBe(200);
                }),
              { concurrency: 2, discard: true },
            );
            expect((yield* call("mutations.echo", refreshedHeaders)).status).toBe(403);
            const empty = yield* body(
              Inventory,
              yield* api.request(
                anonymous,
                "GET",
                `${prefix}/inventory`,
                undefined,
                refreshedHeaders,
              ),
            );
            expect(empty.apps).toEqual([]);
            const revokedTool = yield* execute(
              `return await tools[${JSON.stringify(app.slug)}].mutations.echo({message: "denied"})`,
            );
            expect(
              (yield* Schema.decodeUnknownEffect(Execution)(revokedTool.structuredContent))
                .execution.ok,
            ).toBe(false);
            yield* oauth.revoke(refreshed);
            expect((yield* call("mutations.echo", refreshedHeaders)).status).toBe(401);
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
