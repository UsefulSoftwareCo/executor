import { expect } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { saveAndDeploy } from "./app-authoring.ts";
import { Api, body } from "./api.ts";
import { Actors } from "./actors.ts";
import { Browser } from "./browser.ts";
import { Evidence } from "./evidence.ts";
import { McpOAuth } from "./mcp-oauth.ts";
import { McpClient } from "./mcp-client.ts";
import { deployMcpApp } from "./mcp-app.ts";
const Tools = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
/** Grant fixtures use public browser consent and preserve exact tool restrictions. */
export const authorizationFixture = (audience: "api" | "mcp") =>
  Effect.gen(function* () {
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
    const grant = yield* evidence.step(
      `Authorize the ${audience} audience through real browser consent`,
      audience === "api" ? oauth.authorizeApi : oauth.authorize,
    );
    const policy = {
      kind: "tools",
      apps: [{ app: app.id, tools: { kind: "selected", names: ["mutations.echo"] } }],
      approval: "client",
    };
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
    const headers = { authorization: `Bearer ${Redacted.value(grant.tokens).access_token}` };
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
        if (audience === "api") {
          const selectedTools = yield* body(
            Tools,
            yield* api.request(
              anonymous,
              "GET",
              `${prefix}/apps/${app.id}/tools`,
              undefined,
              headers,
            ),
          );
          expect(selectedTools.items.map((item) => item.name)).toEqual(["mutations.echo"]);
          expect((yield* call("mutations.later")).status).toBe(403);
        }
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
      grant,
      headers,
      call,
      addTool,
    };
  });
