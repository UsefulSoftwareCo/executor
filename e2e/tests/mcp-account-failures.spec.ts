/**
 * One linked account whose MCP server fails discovery does not take the app's other accounts down
 * with it: their tools stay listed and callable, and the failure is reported for the broken one.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { mcpSdkVersion, withApps } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Struct({ protocolVersion: Schema.optional(Schema.String) })),
});

/** The token of the account whose server does not answer `tools/list`. */
const brokenToken = "synthetic-broken-token";

/**
 * An MCP server that lists and runs `lookup` for every token but one: for `brokenToken` it answers
 * `tools/list` with JSON-RPC -32601, as a server that does not serve that account's catalog does.
 */
const accountMcpServer = Effect.gen(function* () {
  const answer = (id: string | number, body: object) =>
    HttpServerResponse.json({ jsonrpc: "2.0", id, ...body });
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
    const message = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcRequest))(
      yield* request.text,
    );
    if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
    const broken = request.headers.authorization === `Bearer ${brokenToken}`;
    switch (message.method) {
      case "initialize":
        return yield* answer(message.id, {
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "Account fixture", version: "1.0.0" },
          },
        });
      case "tools/list":
        if (broken)
          return yield* answer(message.id, {
            error: { code: -32601, message: "Method not found" },
          });
        return yield* answer(message.id, {
          result: {
            tools: [
              {
                name: "lookup",
                description: "Look up an item",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        });
      case "tools/call":
        return yield* answer(message.id, {
          result: {
            content: [{ type: "text", text: "found" }],
            structuredContent: { found: true },
          },
        });
      default:
        return yield* answer(message.id, {
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
  return { url: `http://127.0.0.1:${server.address.port}/mcp` };
});

/** The generated MCP app for per-member accounts: every linked account's server, combined. */
const appFiles = (url: string) => [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
    }),
  },
  {
    path: "index.ts",
    content: `import { accountRouter, defineApp, defineProvider, object, secrets, string } from "apps";
import { mcpRouter } from "apps/mcp";
const provider = defineProvider({ name: "Account fixture", hosts: ${JSON.stringify([new URL(url).host])}, auth: { key: secrets({ label: "Token", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: provider.many() } } }, async ({ user, signal, cache }) => ({
  tools: await accountRouter(user?.accounts.service ?? [], (account) => mcpRouter({
    url: ${JSON.stringify(url)},
    account,
    cache,
    headers: { Authorization: "Bearer " + account.fields.token },
    signal,
  }), { signal }),
}));`,
  },
];

const Index = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String })),
  routers: Schema.Array(
    Schema.Struct({ path: Schema.String, error: Schema.optional(Schema.Unknown) }),
  ),
});

const Executed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
  }),
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
});

layer(HostedLive, { excludeTestServices: true })("MCP account failures", (it) => {
  it.effect(scenarios.mcpAccountFailureIsolated.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const server = yield* accountMcpServer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Account MCP ${randomUUID().slice(0, 8)}`,
          files: appFiles(server.url),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Account failures",
          }),
        );
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
            yield* api.request(actors.owner, "DELETE", path);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        // Connecting from the app links each account to it; `.many()` uses every linked one.
        const connect = (label: string, token: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(path, "user", "service"),
                {},
              ),
            );
            const submitted = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "key", label, fields: { token } },
            );
            expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
            const id = (yield* body(Resource, submitted)).id;
            accounts.push(id);
            return id;
          });
        const working = yield* connect("Working", randomUUID());
        const broken = yield* connect("Broken", brokenToken);

        // The working account's tools are listed; the broken account's failure is reported on
        // the router it lists through instead of failing the whole listing.
        const indexed = yield* api.request(actors.owner, "GET", `${path}/tools/index`);
        yield* evidence.json("index.json", indexed);
        expect(indexed.status, JSON.stringify(indexed.body)).toBe(200);
        const index = yield* body(Index, indexed);
        expect(index.items.map((tool) => tool.name)).toEqual(["lookup"]);
        const failed = index.routers.filter((router) => router.error !== undefined);
        expect(failed).toHaveLength(1);
        expect(JSON.stringify(failed[0]?.error)).toContain("-32601");

        // The working account's tool runs.
        const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "lookup",
          kind: "query",
          input: { accountId: working, input: {} },
        });
        yield* evidence.json("working-call.json", called);
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(called.body).toMatchObject({ structuredContent: { found: true } });

        // A call with the broken account reports that account's failure, not invalid input.
        const refused = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "lookup",
          kind: "query",
          input: { accountId: broken, input: {} },
        });
        yield* evidence.json("broken-call.json", refused);
        expect(refused.status).not.toBe(200);
        expect(JSON.stringify(refused.body)).toContain("Method not found");

        // Through MCP execute the agent can still use the working account, and is told why the
        // other one is unavailable.
        const client = yield* mcp.connect(key.key, "account-failures", {
          organization: actors.organization.id,
        });
        const executed = yield* client.use("Call the working account's tool", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools[${JSON.stringify(app.slug)}].lookup({ accountId: ${JSON.stringify(working)}, input: {} });`,
              },
            },
            undefined,
            { signal },
          ),
        );
        yield* evidence.json("execute.json", executed.structuredContent);
        const result = yield* Schema.decodeUnknownEffect(Executed)(executed.structuredContent);
        expect(result.execution, JSON.stringify(result.execution)).toMatchObject({ ok: true });
        const reason = result.unavailableApps.find((entry) => entry.app === app.id)?.reason;
        expect(reason).toContain("Method not found");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
