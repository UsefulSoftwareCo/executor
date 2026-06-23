// Health checks for MCP connections, liveness-only: a connection's credential is
// probed by dialing the server and listing tools (the same path tool discovery
// uses). A live token reads healthy; a revoked/wrong token reads expired. MCP
// has no usable identity source, so there is no identity field and no operation
// picker - only the alive/expired signal. The connect-modal "Validate key" path
// (connections.validate) runs the same probe on an unsaved credential.
//
// The upstream is a real in-process MCP server (the plugin's own test helper)
// gated on a bearer token, so revoking the token mid-scenario reproduces the
// "dev token expired" transition on a saved connection.
import { randomBytes } from "node:crypto";

import { Effect } from "effect";
import { expect } from "@effect/vitest";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeEchoMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { variable } from "@executor-js/sdk/http-auth";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const newSlug = (prefix: string) =>
  IntegrationSlug.make(`${prefix}-${randomBytes(4).toString("hex")}`);

scenario(
  "Health checks · MCP liveness reports healthy, then expired when the token is revoked",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client: Client = yield* makeClient(api, identity);
      const goodToken = `mcp_${randomBytes(8).toString("hex")}`;
      const slug = newSlug("hc-mcp");
      const name = ConnectionName.make("main");

      // A real MCP server gated on the bearer token. `live` flips off to
      // reproduce a revoked credential against an already-saved connection.
      let live = true;
      const server = yield* serveMcpServer(() => makeEchoMcpServer({ name: "liveness-mcp" }), {
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(live && authorization === `Bearer ${goodToken}`),
        },
      });

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.mcp.addServer({
            payload: {
              transport: "remote",
              name: "Liveness MCP",
              endpoint: server.url,
              slug: String(slug),
              // Pin streamable-http so the probe's failure is the server's 401
              // (no auto SSE fallback to muddy the classification).
              remoteTransport: "streamable-http",
              authenticationTemplate: [
                {
                  slug: "bearer",
                  type: "apiKey",
                  headers: { Authorization: ["Bearer ", variable("token")] },
                },
              ],
            },
          });

          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration: slug,
              template: AuthTemplateSlug.make("bearer"),
              value: goodToken,
            },
          });

          // Saved connection with the live token: alive.
          const healthy = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name },
          });
          expect(healthy.status, "a live MCP credential is healthy").toBe("healthy");

          // Key-first validate (unsaved credential) runs the same probe.
          const validated = yield* client.connections.validate({
            payload: {
              owner: "org",
              integration: slug,
              template: AuthTemplateSlug.make("bearer"),
              value: goodToken,
            },
          });
          expect(validated.status, "validating a live key is healthy").toBe("healthy");
          const rejected = yield* client.connections.validate({
            payload: {
              owner: "org",
              integration: slug,
              template: AuthTemplateSlug.make("bearer"),
              value: "wrong-token",
            },
          });
          expect(rejected.status, "validating a rejected key is expired").toBe("expired");

          // The upstream revokes the saved token: the same connection now expired.
          live = false;
          const expired = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name },
          });
          expect(expired.status, "a revoked MCP credential reads expired").toBe("expired");
          // No identity is ever derived for MCP (manual label only).
          expect(expired.identity, "MCP surfaces no derived identity").toBeUndefined();
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore);
          yield* client.mcp.removeServer({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
