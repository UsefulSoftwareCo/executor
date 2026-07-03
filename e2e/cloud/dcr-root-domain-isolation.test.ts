// Cloud: the DCR root-domain collision, end to end over the product API.
//
// The bug this guards (issue #1120): two DIFFERENT integrations can share one
// registrable root domain but differ by host, e.g. a "Cloudflare" MCP
// integration whose OAuth lives on mcp.cloudflare.com vs the plain "Cloudflare"
// REST integration on api.cloudflare.com. When the MCP integration is connected
// it Dynamic-Client-Registers an oauth_client automatically. That auto-minted
// client must NEVER leak into the REST integration's Add-connection app picker
// (it is plumbing, not an app the user picked), and connecting the MCP
// integration a second time must REUSE the same client rather than mint a
// "name 2" duplicate.
//
// Everything here is over the wire: the typed product client drives the real
// cloud API, and a real authorization server (with an RFC 7591 registration
// endpoint) runs inside the scenario on 127.0.0.1. To reproduce the collision
// the scenario stores mcp.cloudflare.com / api.cloudflare.com as the clients'
// endpoint URLs (the classifier keys off those strings, never the network)
// while pointing the actual registration round-trip at the local server.
//
// This e2e proves the SERVER-SIDE half over the wire: (b) DCR mints a client
// against the MCP host, (d) reconnecting reuses it with no duplicate row, and
// the REAL `listClients` projection marks that client as
// `dynamic_client_registration` while preserving its mcp.cloudflare.com
// endpoints. Those two facts (origin kind + persisted host) are the entire
// input the picker classifier keys off. The picker's own verdict for the REST
// integration (that the DCR client is offered in no tier) is asserted against
// the exact production classifier in the React package's integration test
// (packages/react/src/plugins/dcr-root-domain-isolation.test.ts); it lives
// there because that pure function ships in @executor-js/react, and the e2e
// package deliberately does not depend on the React layer. See the report.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug, OAuthClientSlug } from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

// A same-provider, different-host pair: same registrable root (cloudflare.com),
// distinct hosts. These are the endpoint URLs the clients are PERSISTED with,
// which is all the classifier looks at.
const MCP_ISSUER = "https://mcp.cloudflare.com";
const MCP_AUTHORIZE = "https://mcp.cloudflare.com/authorize";
const MCP_TOKEN = "https://mcp.cloudflare.com/token";
const REST_AUTHORIZE = "https://api.cloudflare.com/client/v4/oauth/authorize";
const REST_TOKEN = "https://api.cloudflare.com/client/v4/oauth/token";

scenario(
  "OAuth DCR · an MCP integration's auto-registered client never leaks into a same-root REST integration's app picker, and reconnecting reuses it",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      // A real authorization server with an RFC 7591 registration endpoint. Its
      // /register mints a client_id; the mcp.cloudflare.com URLs above are what
      // we persist so the classifier sees the real-world collision shape.
      const oauth = yield* serveOAuthTestServer();
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);

      // Two integrations on the SAME provider root, different hosts: an MCP-style
      // one (mcp.cloudflare.com) and a plain REST one (api.cloudflare.com).
      const mcpIntegration = IntegrationSlug.make(unique("cloudflare_mcp"));
      const restIntegration = IntegrationSlug.make(unique("cloudflare_api"));

      // The REST integration declares its OAuth endpoints up front (api.cloudflare.com).
      yield* client.openapi.addSpec({
        payload: {
          spec: {
            kind: "blob",
            value: JSON.stringify({
              openapi: "3.0.3",
              info: { title: "Cloudflare REST API", version: "1.0.0" },
              paths: {
                "/zones": {
                  get: {
                    operationId: "listZones",
                    tags: ["default"],
                    responses: { "200": { description: "zones" } },
                  },
                },
              },
            }),
          },
          slug: restIntegration,
          baseUrl: "https://api.cloudflare.com/client/v4",
          authenticationTemplate: [
            {
              slug: "oauth",
              kind: "oauth2",
              authorizationUrl: REST_AUTHORIZE,
              tokenUrl: REST_TOKEN,
              scopes: ["read"],
            },
          ],
        },
      });

      // (b) Connect the MCP-style integration via Dynamic Client Registration.
      // The registration round-trip hits the real local server; the persisted
      // client carries the mcp.cloudflare.com endpoints and its issuer.
      const registerMcp = () =>
        client.oauth.registerDynamic({
          payload: {
            owner: "org",
            // Passed but overridden by the server's deterministic dcr-<host> slug
            // when an issuer is present; kept as a fallback for the no-issuer path.
            slug: OAuthClientSlug.make(unique("cloudflare-mcp")),
            issuer: MCP_ISSUER,
            registrationEndpoint: oauth.registrationEndpoint,
            authorizationUrl: MCP_AUTHORIZE,
            tokenUrl: MCP_TOKEN,
            scopes: ["read"],
            clientName: "Cloudflare MCP",
            originIntegration: mcpIntegration,
          },
        });

      const first = yield* registerMcp();
      expect(
        String(first.client),
        "the auto-registered client gets a deterministic issuer-host slug",
      ).toBe("dcr-mcp-cloudflare-com");

      // (d) Reconnect the MCP integration: the SAME authorization server (issuer)
      // must reuse the existing client, not mint a duplicate "…-2".
      const second = yield* registerMcp();
      expect(
        String(second.client),
        "reconnecting the MCP integration reuses the same DCR client (no duplicate row)",
      ).toBe(String(first.client));

      // The REAL API projection of every client the owner can see. This is the
      // exact shape the picker classifier consumes.
      const clients = yield* client.oauth.listClients();
      const dcrRows = clients.filter(
        (entry) => entry.origin.kind === "dynamic_client_registration",
      );
      expect(
        dcrRows.map((entry) => String(entry.slug)),
        "exactly one DCR client exists for the shared authorization server (no duplicate)",
      ).toEqual(["dcr-mcp-cloudflare-com"]);

      const dcrRow = dcrRows[0]!;
      // The picker excludes a client iff its origin is DCR — assert the API
      // projects that origin so the classifier will hide it.
      expect(
        dcrRow.origin.kind,
        "the auto-registered client is projected as a DCR client (the flag the picker hides on)",
      ).toBe("dynamic_client_registration");
      // The persisted endpoints are the MCP host, NOT the local registration
      // server: this is the same-root/different-host collision the classifier
      // must not silently promote into the REST integration's picker.
      expect(
        dcrRow.tokenUrl,
        "the DCR client keeps the MCP host it was registered for, not the registration endpoint",
      ).toBe(MCP_TOKEN);
      // Sanity: the REST integration itself has NO manual app, so its picker
      // would fall back to near/other tiers if the DCR client were ever
      // classified as a real app — the React test proves it never is.
      expect(
        clients.some((entry) => entry.origin.kind === "manual"),
        "no manual OAuth app was registered in this scenario",
      ).toBe(false);
    }),
  ),
);
