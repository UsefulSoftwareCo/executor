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
import { connectionsPath } from "../support/app-accounts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { withApps, mcpSdkVersion } from "../support/apps-release.ts";

const ui = "io.modelcontextprotocol/ui";
const html = "text/html;profile=mcp-app";
const board = "ui://fixture/board.html";
const secret = "ui://fixture/secret.html";
const widgetMeta = {
  ui: {
    csp: {
      connectDomains: ["https://api.fixture.test"],
      resourceDomains: ["https://cdn.fixture.test"],
    },
    permissions: { clipboardWrite: {} },
    prefersBorder: true,
  },
};
const page = `<!doctype html><html><body>${"board ".repeat(250_000)}</body></html>`;

const Wire = Schema.Struct({
  id: Schema.optionalKey(Schema.Json),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

const upstream = () =>
  Effect.gen(function* () {
    const sessions = new Map<string, boolean>();
    const seen = {
      initialize: [] as Array<boolean>,
      calls: [] as Array<{ name: string; arguments: Schema.Json; authorization?: string }>,
      reads: [] as Array<{ uri: string; authorization?: string }>,
    };
    const routes = Layer.mergeAll(
      HttpRouter.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
      HttpRouter.add("DELETE", "/mcp", HttpServerResponse.empty({ status: 200 })),
      HttpRouter.add(
        "POST",
        "/mcp",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const message = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Wire)),
          );
          if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
          const authorization = request.headers.authorization;
          const session = request.headers["mcp-session-id"];
          const result = (value: Schema.Json, headers: Record<string, string> = {}) =>
            HttpServerResponse.json(
              { jsonrpc: "2.0", id: message.id ?? null, result: value },
              { headers },
            );
          if (message.method === "initialize") {
            const capabilities = message.params?.capabilities;
            const extensions =
              typeof capabilities === "object" &&
              capabilities !== null &&
              "extensions" in capabilities
                ? capabilities.extensions
                : undefined;
            const declared =
              typeof extensions === "object" && extensions !== null && ui in extensions;
            seen.initialize.push(declared);
            const id = randomUUID();
            sessions.set(id, declared);
            return yield* result(
              {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {}, resources: {} },
                serverInfo: { name: "Board fixture", version: "1" },
              },
              { "mcp-session-id": id },
            );
          }
          const withUi = session !== undefined && sessions.get(session) === true;
          if (message.method === "tools/list")
            return yield* result({
              tools: [
                {
                  name: "show_board",
                  description: "Show a board.",
                  inputSchema: {
                    type: "object",
                    properties: { boardId: { type: "string" } },
                    required: ["boardId"],
                  },
                  annotations: { readOnlyHint: true },
                  ...(withUi ? { _meta: { ui: { resourceUri: board } } } : {}),
                },
                {
                  name: "move_card",
                  description: "Move a card.",
                  inputSchema: {
                    type: "object",
                    properties: { cardId: { type: "string" } },
                    required: ["cardId"],
                  },
                  annotations: { destructiveHint: true },
                  ...(withUi ? { _meta: { ui: { resourceUri: board, visibility: ["app"] } } } : {}),
                },
                {
                  name: "plain_tool",
                  description: "A tool without a UI.",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                },
              ],
            });
          if (message.method === "resources/read") {
            const uri = String(message.params?.uri);
            seen.reads.push({ uri, ...(authorization === undefined ? {} : { authorization }) });
            if (uri !== board && uri !== secret)
              return yield* HttpServerResponse.json({
                jsonrpc: "2.0",
                id: message.id ?? null,
                error: { code: -32002, message: "Resource not found" },
              });
            return yield* result({
              contents: [{ uri, mimeType: html, text: page, _meta: widgetMeta }],
            });
          }
          if (message.method === "tools/call") {
            const name = String(message.params?.name);
            const args = message.params?.arguments ?? {};
            seen.calls.push({
              name,
              arguments: args,
              ...(authorization === undefined ? {} : { authorization }),
            });
            const value = { tool: name, arguments: args };
            return yield* result({
              content: [{ type: "text", text: JSON.stringify(value) }],
              structuredContent: value,
            });
          }
          return yield* result({});
        }),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Expected TCP fixture");
    return { url: `http://127.0.0.1:${server.address.port}/mcp`, seen };
  });

const source = (url: string) => [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
    }),
  },
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, accountRouter, secrets, object, string, toolAnnotations, withApprovals } from "apps";
import { mcpRouter } from "apps/mcp";
import { always } from "apps/operations/approval";
const provider = defineProvider({ name: "Board fixture", hosts: ${JSON.stringify([new URL(url).host])}, auth: { key: secrets({ label: "Token", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: provider.many() } } }, async ({ user, signal, cache }) => ({
  tools: await accountRouter(user?.accounts.service ?? [], async (account) => withApprovals(await mcpRouter({
    url: ${JSON.stringify(url)},
    account,
    cache,
    headers: { Authorization: "Bearer " + account.fields.token },
    signal,
  }), (tool) => (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined)), { signal }),
}));`,
  },
];

const ReadResult = Schema.Struct({
  contents: Schema.Array(
    Schema.Struct({
      uri: Schema.String,
      mimeType: Schema.String,
      text: Schema.String,
      _meta: Schema.Json,
    }),
  ),
});

layer(HostedLive, { excludeTestServices: true })("MCP Apps", (it) => {
  it.effect(scenarios.mcpAppsUpstreamUi.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const mcp = yield* McpClient;
        const fixture = yield* upstream();
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Board ${randomUUID().slice(0, 8)}`,
          files: source(fixture.url),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const token = randomUUID();
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
        );
        const account = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            {
              method: "key",
              label: "Board token",
              fields: { token },
            },
          ),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "mcp-apps",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const organization = actors.organization.id;
        const widget = `ui://executor/${app.slug}/fixture/board.html`;

        const plain = yield* mcp.connect(key.key, "mcp-apps-plain", {
          organization,
          mode: "model",
        });
        const plainTools = yield* plain.use("List tools without MCP Apps", (client) =>
          client.listTools(),
        );
        expect(plainTools.tools.map((tool) => tool.name).sort()).toEqual([
          "call",
          "describe",
          "execute",
          "resume",
          "search",
          "skills",
        ]);
        const plainRead = yield* plain
          .use("Read a widget without MCP Apps", (client) => client.readResource({ uri: widget }))
          .pipe(Effect.flip);
        expect(String(plainRead)).toContain("-32002");

        const host = yield* mcp.connect(key.key, "mcp-apps-host", {
          organization,
          mode: "native",
          extensions: { [ui]: { mimeTypes: [html] } },
        });
        const listed = yield* host.use("List tools with MCP Apps", (client) => client.listTools());
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "call",
          "describe",
          "execute",
          "move_card",
          "search",
          "show_board",
          "skills",
        ]);
        expect(fixture.seen.initialize.length).toBeGreaterThan(0);
        expect(fixture.seen.initialize.every((declared) => declared)).toBe(true);
        const show = listed.tools.find((tool) => tool.name === "show_board");
        const move = listed.tools.find((tool) => tool.name === "move_card");
        expect(show?._meta).toEqual({ ui: { resourceUri: widget } });
        expect(move?._meta).toEqual({ ui: { resourceUri: widget, visibility: ["app"] } });
        expect(show?.inputSchema).toMatchObject({
          type: "object",
          properties: { boardId: { type: "string" } },
        });
        expect(show?.outputSchema).toBeUndefined();
        for (const own of ["call", "describe", "execute", "search", "skills"])
          expect(listed.tools.find((tool) => tool.name === own)?._meta, own).toMatchObject({
            ui: { visibility: ["model"] },
          });

        const read = yield* Schema.decodeUnknownEffect(ReadResult)(
          yield* host.use("Read the widget", (client) => client.readResource({ uri: widget })),
        );
        expect(read.contents).toHaveLength(1);
        expect(read.contents[0]?.uri).toBe(widget);
        expect(read.contents[0]?.mimeType).toBe(html);
        expect(read.contents[0]?.text).toBe(page);
        expect(read.contents[0]?._meta).toEqual(widgetMeta);
        expect(fixture.seen.reads).toEqual([{ uri: board, authorization: `Bearer ${token}` }]);

        const refused = yield* host
          .use("Read a resource no tool declares", (client) =>
            client.readResource({ uri: `ui://executor/${app.slug}/fixture/secret.html` }),
          )
          .pipe(Effect.flip);
        expect(String(refused)).toContain("-32002");
        expect(fixture.seen.reads.map(({ uri }) => uri)).toEqual([board]);
        const direct = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "resources/read",
          kind: "query",
          input: { accountId: account.id, input: { uri: secret } },
        });
        expect(direct.status).not.toBe(200);
        expect(fixture.seen.reads.map(({ uri }) => uri)).toEqual([board]);

        const shown = yield* host.use("Call the widget's read tool", (client) =>
          client.callTool({ name: "show_board", arguments: { boardId: "b1" } }),
        );
        expect(shown.isError).not.toBe(true);
        expect(shown.structuredContent).toEqual({
          tool: "show_board",
          arguments: { boardId: "b1" },
        });
        expect(shown.content).toEqual([
          { type: "text", text: JSON.stringify(shown.structuredContent) },
        ]);
        expect(yield* host.elicitationCount).toBe(0);

        const moved = yield* host.use("Call the widget's destructive tool", (client) =>
          client.callTool({ name: "move_card", arguments: { cardId: "c1" } }),
        );
        expect(moved.isError).not.toBe(true);
        expect(yield* host.elicitationCount).toBe(1);
        expect(fixture.seen.calls).toEqual([
          { name: "show_board", arguments: { boardId: "b1" }, authorization: `Bearer ${token}` },
          { name: "move_card", arguments: { cardId: "c1" }, authorization: `Bearer ${token}` },
        ]);

        const silent = yield* mcp.connect(key.key, "mcp-apps-no-elicitation", {
          organization,
          mode: "model",
          extensions: { [ui]: { mimeTypes: [html] } },
        });
        const declined = yield* silent.use(
          "Call a destructive tool without elicitation",
          (client) => client.callTool({ name: "move_card", arguments: { cardId: "c2" } }),
        );
        expect(declined.isError).toBe(true);
        expect(JSON.stringify(declined.content)).toContain("cannot show the request");
        expect(fixture.seen.calls.map(({ arguments: args }) => args)).toEqual([
          { boardId: "b1" },
          { cardId: "c1" },
        ]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
