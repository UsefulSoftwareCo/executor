import { randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "MCP · deleting a host session closes its upstream connection",
  { timeout: 120_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const apiClient = yield* makeClient(api, identity);
      const slug = IntegrationSlug.make(`session_cleanup_${randomBytes(4).toString("hex")}`);
      const upstream = yield* serveMcpServer(makeGreetingMcpServer);
      yield* apiClient.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Session cleanup",
          endpoint: upstream.url,
          slug,
          remoteTransport: "streamable-http",
        },
      });
      yield* Effect.gen(function* () {
        yield* apiClient.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: slug,
            template: AuthTemplateSlug.make("none"),
            value: "",
          },
        });
        yield* Effect.promise(() => expect.poll(upstream.inFlightRequests).toBe(0));
        const transport = new StreamableHTTPClientTransport(new URL(target.mcpUrl), {
          requestInit: { headers: identity.headers },
        });
        const client = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const connected = new Client({ name: "session-cleanup-e2e", version: "1" });
            await connected.connect(transport);
            return connected;
          }),
          (connected) => Effect.promise(() => connected.close()),
        );
        const result = yield* Effect.promise(() =>
          client.callTool({
            name: "execute",
            arguments: { code: `return await tools.${slug}.org.main.simple_echo({});` },
          }),
        );
        expect(result.isError).toBeFalsy();
        expect(JSON.stringify(result.content)).toContain("mcp-ok");
        yield* Effect.promise(() =>
          expect
            .poll(upstream.inFlightRequests, {
              message: "the tool leaves its upstream event stream open for reuse",
            })
            .toBeGreaterThan(0),
        );
        yield* Effect.promise(() => transport.terminateSession());
        yield* Effect.promise(() =>
          expect
            .poll(upstream.inFlightRequests, {
              timeout: 10_000,
              message: "closing the host session releases its upstream event stream",
            })
            .toBe(0),
        );
      }).pipe(Effect.ensuring(apiClient.mcp.removeServer({ params: { slug } }).pipe(Effect.orDie)));
    }),
  ),
);
