// Cloud: connection refresh semantics over the wire. Tools are produced
// per-connection by the owning plugin; `connections.refresh` re-runs that
// discovery — for MCP it re-dials the LIVE server, so a server-side tool
// change replaces the stamped tool rows. `canRefresh` on the integration says
// whether the catalog row can be refreshed at all: a spec registered from a
// URL can be re-fetched, a pasted blob cannot.
//
// Ported from apps/cloud/src/api/sources-refresh.node.test.ts. The upstream
// MCP server is a real HTTP server started inside the scenario on 127.0.0.1.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin(), mcpHttpPlugin()] as const);

const newSlug = (prefix: string) =>
  IntegrationSlug.make(`${prefix}_${randomBytes(4).toString("hex")}`);

const MAIN = ConnectionName.make("main");
const NONE = AuthTemplateSlug.make("none");

/** Minimal OpenAPI 3 spec with a single GET /ping operation. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Refresh Fixture", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Return a pong",
        tags: ["default"],
        responses: { "200": { description: "pong" } },
      },
    },
  },
});

/** A real node:http server on 127.0.0.1 that serves `body` on every request,
 *  closed by the scope's finalizer. */
const serveJson = (body: string) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/spec.json`,
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

scenario(
  "Connections · refreshing an MCP connection re-dials the live server and replaces its tools",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const apiSurface = yield* Api;
      // The factory is re-invoked per MCP session, so flipping `toolName`
      // changes what the NEXT discovery dial sees.
      let toolName = "before_refresh";
      const server = yield* serveMcpServer(() =>
        makeGreetingMcpServer({ name: "refresh-mcp", toolName, text: "ok" }),
      );
      const identity = yield* target.newIdentity();
      const client = yield* apiSurface.client(api, identity);
      const slug = newSlug("refmcp");

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Refresh MCP",
          endpoint: server.endpoint,
          remoteTransport: "streamable-http",
          slug,
        },
      });
      yield* client.connections.create({
        payload: {
          owner: "org",
          name: MAIN,
          integration: slug,
          template: NONE,
          value: "unused",
        },
      });

      const before = yield* client.tools.list({ query: { integration: slug } });
      expect(
        before.map((tool) => String(tool.address)),
        "the connection stamped the server's current tool",
      ).toContain(`tools.${slug}.org.main.before_refresh`);

      // The server's catalog changes; only a refresh may pick that up.
      toolName = "after_refresh";
      const refreshed = yield* client.connections.refresh({
        params: { owner: "org", integration: slug, name: MAIN },
      });
      expect(
        refreshed.map((tool) => String(tool.address)),
        "refresh returns the re-discovered tool set",
      ).toContain(`tools.${slug}.org.main.after_refresh`);

      const after = yield* client.tools.list({ query: { integration: slug } });
      const addresses = after.map((tool) => String(tool.address));
      expect(addresses, "the stale tool row is gone").not.toContain(
        `tools.${slug}.org.main.before_refresh`,
      );
      expect(addresses, "the new tool row is persisted").toContain(
        `tools.${slug}.org.main.after_refresh`,
      );
    }),
  ),
);

scenario(
  "Integrations · a spec registered from a URL is refreshable (canRefresh)",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const apiSurface = yield* Api;
      const specServer = yield* serveJson(pingSpec);
      const identity = yield* target.newIdentity();
      const client = yield* apiSurface.client(api, identity);
      const slug = newSlug("refurl");

      yield* client.openapi.addSpec({
        payload: {
          spec: { kind: "url", url: specServer.url },
          slug,
          baseUrl: "http://127.0.0.1:59999",
        },
      });

      const integration = yield* client.integrations.get({ params: { slug } });
      expect(
        integration?.canRefresh,
        "a URL-sourced spec can be re-fetched, so the integration is refreshable",
      ).toBe(true);
    }),
  ),
);

scenario(
  "Integrations · a spec pasted as a blob is not refreshable (canRefresh)",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(api, identity);
    const slug = newSlug("refblob");

    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        baseUrl: "https://api.example.test",
      },
    });

    const integration = yield* client.integrations.get({ params: { slug } });
    expect(
      integration?.canRefresh,
      "a pasted blob has no upstream to re-poll, so the integration is not refreshable",
    ).toBe(false);
  }),
);
