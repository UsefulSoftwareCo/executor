// ---------------------------------------------------------------------------
// MCP query-parameter credential auth.
//
// Some MCP servers (e.g. ui.sh) authenticate via a query-string token
// (`?token=<value>`) rather than a header or OAuth. This pins the end-to-end
// path: an integration declaring a `query` auth method, a connection holding
// the token, and the token rendered into the endpoint's query string on every
// request the server actually receives.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";
import { describeMcpAuthMethods } from "./plugin";
import { makeEchoMcpServer, serveMcpServer } from "../testing";

const INTEG = IntegrationSlug.make("query_mcp");
const TEMPLATE = AuthTemplateSlug.make("query");

const serveQueryMcpServer = serveMcpServer(() =>
  makeEchoMcpServer({
    name: "query-test",
    toolName: "whoami",
    inputName: "marker",
    text: (marker) => `ok:${marker}`,
  }),
);

describe("MCP query-parameter credential", () => {
  it.effect("renders the connection's token into the endpoint query string", () =>
    Effect.gen(function* () {
      const server = yield* serveQueryMcpServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
      );

      // Declare a query-param auth method (the ui.sh `?token=` shape).
      yield* executor.mcp.addServer({
        name: "Query MCP",
        endpoint: server.url,
        slug: String(INTEG),
        authenticationTemplate: [{ kind: "query", paramName: "token", slug: String(TEMPLATE) }],
      });

      // The catalog projects it as an apikey method carrying the query placement.
      const integration = yield* executor.integrations.get(INTEG);
      expect(integration?.authMethods).toEqual([
        {
          id: "query",
          label: "API key (token)",
          kind: "apikey",
          template: "query",
          placements: [{ carrier: "query", name: "token", prefix: "" }],
        },
      ]);

      const token = "tok_secret_123";
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        value: token,
      });

      // Invoking a tool dials the server; the token must ride in the URL.
      const result = yield* executor.execute(
        ToolAddress.make("tools.query_mcp.org.main.whoami"),
        { marker: "hi" },
        { onElicitation: "accept-all" },
      );
      expect(result).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "ok:hi" }] },
      });

      const requests = yield* server.requests;
      expect(
        requests.some((request) => request.url.includes(`token=${token}`)),
        "the server saw the token rendered into the query string",
      ).toBe(true);
      // The token is NOT sent as an Authorization header for a query method.
      expect(
        requests.every((request) => request.authorization === undefined),
        "no Authorization header for a query-param credential",
      ).toBe(true);
    }),
  );

  it("describeMcpAuthMethods round-trips a query method (unit)", () => {
    const methods = describeMcpAuthMethods({
      slug: INTEG,
      description: "Query MCP",
      kind: "mcp",
      canRemove: true,
      canRefresh: true,
      authMethods: [],
      config: {
        transport: "remote",
        endpoint: "https://ui.sh/mcp",
        authenticationTemplate: [{ slug: "token", kind: "query", paramName: "token", prefix: "" }],
      },
    });
    expect(methods[0]).toMatchObject({
      kind: "apikey",
      placements: [{ carrier: "query", name: "token", prefix: "" }],
    });
  });
});
