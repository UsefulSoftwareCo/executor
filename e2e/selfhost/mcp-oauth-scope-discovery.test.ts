// Selfhost-only: an MCP integration declares NO oauth scopes — the server does.
// At connect, `oauth.start` DISCOVERS the request scopes from the MCP server's
// RFC 9728 protected-resource metadata and asks for exactly those on the
// authorize URL. Proven end-to-end: a real MCP server (in this process)
// publishes `scopes_supported`; the selfhost dev server fetches it over loopback
// and the returned authorize URL carries the discovered scopes — not a declared
// set and not the OAuth app's own scopes (the app declares none).
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { scopesFromAuthorizeUrl, serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

// The scopes the MCP server advertises in its protected-resource metadata.
const DISCOVERED_SCOPES = ["channels:history", "users:read"] as const;

const freshSlug = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

scenario(
  "MCP OAuth · oauth.start requests the scopes the server advertises, not a declared set",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;

      // A real authorization server (endpoints for the OAuth app) and a real MCP
      // server whose RFC 9728 metadata advertises `scopes_supported`. The MCP
      // integration declares NO template scopes — the server is the source.
      const oauth = yield* serveOAuthTestServer();
      const mcp = yield* serveMcpServer(() => makeGreetingMcpServer(), {
        auth: {
          validateAuthorization: () => Effect.succeed(true),
          authorizationServerUrls: [oauth.issuerUrl],
          scopes: [...DISCOVERED_SCOPES],
        },
      });

      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = freshSlug("mcp-scope-discovery");

      // An MCP integration with a single OAuth method — no scopes declared.
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Scope-discovery MCP",
          endpoint: mcp.endpoint,
          slug,
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });
      yield* Effect.addFinalizer(() =>
        client.mcp
          .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
          .pipe(Effect.ignore),
      );

      // An OAuth app bound to the MCP server as its resource (RFC 8707). The app
      // carries no scope set of its own.
      const clientSlug = OAuthClientSlug.make(freshSlug("mcp-scope-app"));
      yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug: clientSlug,
          authorizationUrl: oauth.authorizationEndpoint,
          tokenUrl: oauth.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: mcp.endpoint,
        },
      });
      // Best-effort cleanup: `removeServer` only reaps DCR-shaped clients, so this
      // manually-created app must be removed explicitly.
      yield* Effect.addFinalizer(() =>
        client.oauth
          .removeClient({ params: { slug: clientSlug }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      );

      const started = yield* client.oauth.start({
        payload: {
          owner: "org",
          client: clientSlug,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make(slug),
          template: AuthTemplateSlug.make("oauth2"),
        },
      });

      expect(started.status, "start hands back an authorize redirect").toBe("redirect");
      if (started.status !== "redirect") return;
      // The redirect opened an in-flight OAuth session; drop it so the run leaves
      // no pending session behind.
      yield* Effect.addFinalizer(() =>
        client.oauth.cancel({ payload: { state: started.state } }).pipe(Effect.ignore),
      );

      // The selfhost server fetched the MCP server's protected-resource metadata
      // and requested exactly the scopes it advertised.
      expect(
        scopesFromAuthorizeUrl(started.authorizationUrl),
        "the authorize URL carries exactly the scopes the MCP server advertised",
      ).toEqual([...DISCOVERED_SCOPES]);
    }),
  ),
);
