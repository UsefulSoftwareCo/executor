import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

const api = composePluginApi([openApiHttpPlugin(), toolkitsPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const pingSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Local Toolkit Ping API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/ping/{id}": {
        get: {
          operationId: "getPing",
          summary: "Return a ping payload",
          security: [{ apiKey: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "A ping payload",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      path: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-e2e-token" },
      },
    },
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const servePingApi = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly url: string; readonly server: Server }>((resolve) => {
        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          if (request.method === "GET" && url.pathname.startsWith("/ping/")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: decodeURIComponent(url.pathname.slice("/ping/".length)),
                path: url.pathname,
              }),
            );
            return;
          }
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "not_found" }));
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as AddressInfo;
          resolve({ url: `http://127.0.0.1:${address.port}`, server });
        });
      }),
  ),
  ({ server }) => Effect.promise(() => closeServer(server)).pipe(Effect.ignore),
);

const connectionPattern = (integration: string, name: string): string =>
  `${integration}.org.${name}.*`;

const pingToolPath = (integration: string, name: string): string =>
  `${integration}.org.${name}.ping.getPing`;

const callPingCode = (input: {
  readonly integration: string;
  readonly connection: string;
  readonly id: string;
}) => `
const listed = await tools.search({ namespace: ${JSON.stringify(input.integration)}, query: "ping", limit: 100 });
const expected = ${JSON.stringify(`${input.integration}.org.${input.connection}.`)};
const path = listed.items.map((item) => item.path).find((candidate) => candidate.startsWith(expected));
if (!path) return { ok: false, reason: "missing", expected, paths: listed.items.map((item) => item.path).sort() };
let tool = tools;
for (const segment of path.split(".")) tool = tool?.[segment];
if (typeof tool !== "function") return { ok: false, reason: "not-callable", path };
const result = await tool({ id: ${JSON.stringify(input.id)} });
return JSON.stringify({ ok: result.ok, path, data: result.ok ? result.data : result.error });
`;

const listVisiblePathsCode = (integration: string) => `
const listed = await tools.search({ namespace: ${JSON.stringify(integration)}, query: "ping", limit: 100 });
return JSON.stringify({ paths: listed.items.map((item) => item.path).sort() });
`;

const makeMcp = async (url: string, token: string, name: string) => {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
};

const textFromCall = (result: Awaited<ReturnType<Client["callTool"]>>): string => {
  const blocks = result.content ?? [];
  const text = blocks.find((block) => block.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`MCP call returned no text block`);
  return text;
};

const executeJson = async (client: Client, code: string): Promise<Record<string, unknown>> => {
  const result = await client.callTool({
    name: "execute",
    arguments: { code },
  });
  return JSON.parse(textFromCall(result)) as Record<string, unknown>;
};

scenario(
  "Local toolkits · scoped MCP hides blocked and unselected connections",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const cli = yield* Cli;
      const runDir = yield* RunDir;
      const upstream = yield* servePingApi;

      yield* withLocalServer(cli, runDir, (server) =>
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(api, {
            baseUrl: new URL("/api", server.origin).toString(),
            transformClient: HttpClient.mapRequest((request) =>
              HttpClientRequest.setHeader(request, "authorization", `Bearer ${server.token}`),
            ),
          }).pipe(Effect.provide(FetchHttpClient.layer));

          const integration = unique("local_toolkit_ping");
          const selected = "selected";
          const blocked = "blocked";
          const unselected = "unselected";

          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: pingSpec(upstream.url) },
              slug: IntegrationSlug.make(integration),
              baseUrl: upstream.url,
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: {
                    "x-e2e-token": [{ type: "variable", name: "token" }],
                  },
                },
              ],
            },
          });

          for (const name of [selected, blocked, unselected]) {
            yield* client.connections.create({
              payload: {
                owner: "org",
                name: ConnectionName.make(name),
                integration: IntegrationSlug.make(integration),
                template: AuthTemplateSlug.make("apiKey"),
                value: "unused-token",
              },
            });
          }

          const toolkit = yield* client.toolkits.create({
            payload: { owner: "org", name: unique("local-kit") },
          });
          yield* client.toolkits.createConnection({
            params: { toolkitId: toolkit.id },
            payload: { pattern: connectionPattern(integration, selected) },
          });
          yield* client.toolkits.createConnection({
            params: { toolkitId: toolkit.id },
            payload: { pattern: connectionPattern(integration, blocked) },
          });
          yield* client.toolkits.createPolicy({
            params: { toolkitId: toolkit.id },
            payload: {
              pattern: connectionPattern(integration, selected),
              action: "approve",
            },
          });
          yield* client.toolkits.createPolicy({
            params: { toolkitId: toolkit.id },
            payload: {
              pattern: connectionPattern(integration, blocked),
              action: "block",
            },
          });

          const toolkitMcp = yield* Effect.promise(() =>
            makeMcp(
              new URL(`/mcp/toolkits/${toolkit.slug}`, server.origin).toString(),
              server.token,
              "local-toolkit-e2e",
            ),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => toolkitMcp.client.close()).pipe(Effect.ignore),
          );

          const selectedCall = yield* Effect.promise(() =>
            executeJson(
              toolkitMcp.client,
              callPingCode({
                integration,
                connection: selected,
                id: "from-toolkit",
              }),
            ),
          );
          expect(selectedCall.ok, `selected call: ${JSON.stringify(selectedCall)}`).toBe(true);
          expect((selectedCall.data as { id?: unknown }).id).toBe("from-toolkit");

          const visible = yield* Effect.promise(() =>
            executeJson(toolkitMcp.client, listVisiblePathsCode(integration)),
          );
          expect(visible.paths).toContain(pingToolPath(integration, selected));
          expect(visible.paths).not.toContain(pingToolPath(integration, blocked));
          expect(visible.paths).not.toContain(pingToolPath(integration, unselected));

          const blockedCall = yield* Effect.promise(() =>
            executeJson(
              toolkitMcp.client,
              callPingCode({
                integration,
                connection: blocked,
                id: "blocked-should-not-run",
              }),
            ),
          );
          expect(blockedCall.reason, `blocked call: ${JSON.stringify(blockedCall)}`).toBe(
            "missing",
          );

          const unselectedCall = yield* Effect.promise(() =>
            executeJson(
              toolkitMcp.client,
              callPingCode({
                integration,
                connection: unselected,
                id: "should-not-run",
              }),
            ),
          );
          expect(unselectedCall.reason, `unselected call: ${JSON.stringify(unselectedCall)}`).toBe(
            "missing",
          );

          const defaultMcp = yield* Effect.promise(() =>
            makeMcp(new URL("/mcp", server.origin).toString(), server.token, "local-default-e2e"),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => defaultMcp.client.close()).pipe(Effect.ignore),
          );

          const leakedSession = defaultMcp.transport.sessionId;
          expect(typeof leakedSession, "default MCP session has an id").toBe("string");
          const crossResource = yield* Effect.promise(() =>
            fetch(new URL(`/mcp/toolkits/${toolkit.slug}`, server.origin), {
              method: "POST",
              headers: {
                authorization: `Bearer ${server.token}`,
                "mcp-session-id": leakedSession ?? "",
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
              }),
            }),
          );
          expect(crossResource.status, "default session id cannot cross into toolkit").toBe(403);
        }),
      );
    }),
  ),
);
