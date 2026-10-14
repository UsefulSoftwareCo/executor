/** Remote MCP requests identify Executor unless the app sets its own User-Agent. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { mcpSdkVersion, withApps } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Struct({ protocolVersion: Schema.optional(Schema.String) })),
});

/**
 * An MCP server that, like some Cloudflare-hosted servers, refuses requests without a User-Agent.
 * Its `agent` tool answers with the User-Agent of the request that called it.
 */
const userAgentMcpServer = Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
  const answer = (id: string | number, result: object) =>
    HttpServerResponse.json({ jsonrpc: "2.0", id, result });
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const userAgent = request.headers["user-agent"];
    yield* Ref.update(seen, (agents) => [...agents, userAgent]);
    if (!userAgent) return HttpServerResponse.text("Forbidden", { status: 403 });
    if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
    const message = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcRequest))(
      yield* request.text,
    );
    if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
    switch (message.method) {
      case "initialize":
        return yield* answer(message.id, {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "User-Agent fixture", version: "1.0.0" },
        });
      case "tools/list":
        return yield* answer(message.id, {
          tools: [
            {
              name: "agent",
              description: "Report the caller's User-Agent",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      case "tools/call":
        return yield* answer(message.id, {
          content: [{ type: "text", text: userAgent }],
          structuredContent: { userAgent },
        });
      default:
        return yield* HttpServerResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  });
  const services = yield* Layer.build(
    HttpRouter.serve(HttpRouter.add("*", "/mcp", handler), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return { url: `http://127.0.0.1:${server.address.port}/mcp`, seen: Ref.get(seen) };
});

/**
 * One router with Executor's default User-Agent, and one whose account headers set their own. An
 * app sends headers only with an account, so the custom router runs as one.
 */
const appFiles = (url: string) => [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
    }),
  },
  {
    path: "index.ts",
    content: `import { accountRouter, defineApp, defineProvider, object, router, secrets, string } from "apps";
import { mcpRouter } from "apps/mcp";
const provider = defineProvider({ name: "User-Agent fixture", hosts: ${JSON.stringify([new URL(url).host])}, auth: { key: secrets({ label: "Token", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: provider.many() } } }, async (ctx) => ({ tools: router({
  standard: await mcpRouter({ url: ${JSON.stringify(url)}, signal: ctx.signal }),
  custom: await accountRouter(ctx.user.accounts.service, (account) => mcpRouter({
    url: ${JSON.stringify(url)},
    account,
    headers: { "User-Agent": "Custom MCP client", Authorization: "Bearer " + account.fields.token },
    signal: ctx.signal,
  }), { signal: ctx.signal }),
}) }));`,
  },
];

layer(HostedLive, { excludeTestServices: true })("MCP User-Agent", (it) => {
  it.effect(scenarios.mcpUserAgent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const server = yield* userAgentMcpServer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `MCP User-Agent ${randomUUID().slice(0, 8)}`,
          files: appFiles(server.url),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            if (account !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        // Connecting from the app links the account to it; `.many()` calls use every linked one.
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
        );
        account = (yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            {
              method: "key",
              label: "Synthetic token",
              fields: { token: randomUUID() },
            },
          ),
        )).id;
        for (const [tool, input, userAgent] of [
          ["standard.agent", {}, "Executor"],
          ["custom.agent", { accountId: account, input: {} }, "Custom MCP client"],
        ] as const) {
          const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool,
            kind: "query",
            input,
          });
          yield* evidence.json(`${tool}.json`, called);
          expect(called.status, JSON.stringify(called.body)).toBe(200);
          expect(called.body).toMatchObject({ structuredContent: { userAgent } });
        }
        // Every request reached the server with an identity, including session setup.
        const seen = yield* server.seen;
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen)).toEqual(new Set(["Executor", "Custom MCP client"]));
      }),
    ),
  );
});
