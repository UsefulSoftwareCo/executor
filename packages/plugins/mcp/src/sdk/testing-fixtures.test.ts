import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OAuthTestServer } from "@executor-js/sdk/testing";
import z from "zod";

import { serveMcpServerWithOAuth } from "../testing";

const createGreetingMcpServer = () => {
  const server = new McpServer(
    { name: "executor-test-mcp", version: "1.0.0" },
    { capabilities: {} },
  );

  server.registerTool(
    "hello",
    {
      description: "Greets a person",
      inputSchema: { name: z.string() },
    },
    async ({ name }: { readonly name: string }) => ({
      content: [{ type: "text" as const, text: `Hello ${name}` }],
    }),
  );

  return server;
};

const makeClient = (endpoint: string, accessToken: string) => {
  const client = new Client({ name: "executor-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  });
  return { client, transport };
};

layer(OAuthTestServer.layer(), { timeout: "15 seconds" })("MCP testing fixtures", (it) => {
  it.effect("serves an OAuth-protected MCP server through the MCP SDK transport", () =>
    Effect.gen(function* () {
      const oauth = yield* OAuthTestServer;
      const server = yield* serveMcpServerWithOAuth(createGreetingMcpServer, { path: "/mcp" });
      const token = yield* oauth.completeAuthorizationCodeTokenFlow({
        resource: server.endpoint,
        scopes: ["read"],
      });
      const { client, transport } = makeClient(server.endpoint, token.accessToken);

      yield* Effect.tryPromise(() => client.connect(transport));
      const tools = yield* Effect.tryPromise(() => client.listTools());
      const result = yield* Effect.tryPromise(() =>
        client.callTool({ name: "hello", arguments: { name: "Ada" } }),
      );
      yield* Effect.promise(() => client.close());

      expect(tools.tools.map((tool) => tool.name)).toEqual(["hello"]);
      expect(result).toMatchObject({
        content: [{ type: "text", text: "Hello Ada" }],
      });
      expect(server.sessionCount()).toBe(1);

      const requests = yield* server.requests;
      expect(
        requests.some((request) => request.authorization === `Bearer ${token.accessToken}`),
      ).toBe(true);
    }),
  );
});
