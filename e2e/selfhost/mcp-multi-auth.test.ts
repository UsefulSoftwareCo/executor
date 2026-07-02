// Selfhost-only: on a multi-method MCP integration, the connection's CHOSEN
// method is what renders the credential on the wire. A real MCP test server
// (in this test process — the selfhost dev server dials it over loopback)
// only accepts `Authorization: Bearer <token>`. The integration declares BOTH
// OAuth and a bearer-header method; a connection created through the header
// method must discover the server's tools, and the recorded requests must
// carry the rendered header — proving template selection by slug, not by
// "whatever the config says".
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "Auth methods · the connection's chosen method renders the credential on the wire",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const token = `e2e-key-${randomBytes(6).toString("hex")}`;
      const server = yield* serveMcpServer(() => makeGreetingMcpServer(), {
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === `Bearer ${token}`),
        },
      });

      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = freshSlug("mcp-wire-auth");

      // Two declared methods — the connection must pick the right one.
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Wire-auth MCP",
          endpoint: server.endpoint,
          slug,
          authenticationTemplate: [
            { kind: "oauth2" },
            {
              type: "apiKey",
              headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
            },
          ],
        },
      });

      yield* Effect.gen(function* () {
        // Create the connection through the HEADER method (template slug
        // "header") with a pasted key. Tool discovery dials the server with
        // the rendered credential at create time.
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("wire-auth-key"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("header"),
            value: token,
          },
        });

        const tools = yield* client.tools.list({ query: {} });
        const mine = tools.filter((tool) => String(tool.integration) === slug);
        expect(
          mine.map((tool) => String(tool.name)).join(", "),
          "discovery through the header method found the server's tool",
        ).toContain("simple_echo");

        const requests = yield* server.requests;
        expect(
          requests.some((request) => request.authorization === `Bearer ${token}`),
          "the server saw the credential rendered through the chosen method",
        ).toBe(true);
      }).pipe(
        Effect.ensuring(
          client.mcp
            .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
            .pipe(Effect.ignore),
        ),
      );
    }),
  ),
);

const freshSlug = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;
