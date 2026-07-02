// Selfhost-only, emulate-backed counterpart to mcp-oauth-scope-discovery.test.ts.
// Same claim — an MCP integration declares NO oauth scopes, so `oauth.start`
// DISCOVERS them from the server's metadata at connect — but proven against a
// REAL, deployed emulate MCP server instead of an in-process stub.
//
// The `@executor-js/emulate` GitHub MCP emulator exposes a `scope-discovery`
// instance whose RFC 9728 protected-resource metadata is deliberately SILENT on
// scopes, forcing a spec-faithful client to fall back to the RFC 8414
// authorization-server metadata it names — which advertises the scopes below.
// The selfhost dev server fetches that live metadata over the network and the
// returned authorize URL carries exactly the discovered scopes.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { scopesFromAuthorizeUrl } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

// The deployed emulate instance whose protected-resource metadata is silent on
// scopes (it serves the MCP transport AND its own OAuth authorize/token + the
// RFC 9728/8414 metadata). The `scope-discovery` preset configures it; no seed
// call is needed. Use the path form — a two-label instance subdomain has no
// Universal SSL cert.
const EMULATOR_BASE = "https://emulators.dev/github/scope-discovery";
const MCP_ENDPOINT = `${EMULATOR_BASE}/mcp`;

// The scopes the emulate server advertises, only in its authorization-server
// metadata (the protected-resource metadata stays silent). Discovering them
// proves executor followed the RFC 8414 fallback, not a declared set.
const DISCOVERED_SCOPES = ["channels:history", "users:read"] as const;

const freshSlug = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

scenario(
  "MCP OAuth · oauth.start discovers scopes from a deployed emulate MCP server",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;

      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = freshSlug("mcp-scope-emulate");

      // An MCP integration pointed at the deployed emulate server — no scopes
      // declared on the integration; the server is the source.
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Scope-discovery MCP (emulate)",
          endpoint: MCP_ENDPOINT,
          slug,
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });
      yield* Effect.addFinalizer(() =>
        client.mcp
          .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
          .pipe(Effect.ignore),
      );

      // An OAuth app bound to the emulate MCP server as its resource (RFC 8707),
      // using the emulate instance's own authorize/token endpoints. The app
      // carries no scope set of its own.
      const clientSlug = OAuthClientSlug.make(freshSlug("mcp-scope-emulate-app"));
      yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug: clientSlug,
          authorizationUrl: `${EMULATOR_BASE}/authorize`,
          tokenUrl: `${EMULATOR_BASE}/token`,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: MCP_ENDPOINT,
        },
      });
      // `removeServer` only reaps DCR-shaped clients, so this manually-created
      // app must be removed explicitly.
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

      // The selfhost server fetched the deployed emulate server's metadata —
      // silent protected resource, then its authorization server — and requested
      // exactly the scopes it advertised.
      expect(
        scopesFromAuthorizeUrl(started.authorizationUrl),
        "the authorize URL carries exactly the scopes the deployed emulate MCP server advertises",
      ).toEqual([...DISCOVERED_SCOPES]);
    }),
  ),
);
