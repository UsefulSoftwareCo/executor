// Cross-target: multi-method authentication — an integration declares SEVERAL
// auth methods and a connection picks one by template slug. Covers the unified
// placements model: one apikey method can mix header and query placements,
// each rendered from its own credential input; the merge-append configureAuth
// flow (a custom API key must never displace a detected OAuth method);
// declaring a method on a server that advertises none; GraphQL's multi-method
// add — and the EXTREME case end-to-end: a source declaring
// [oauth] [bearer header + team-id query] [bearer header] [query token],
// one connection per credential method, every invocation asserted against
// what a real recording MCP server received.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeEchoMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { variable } from "@executor-js/sdk/http-auth";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin(), graphqlHttpPlugin()] as const);

const freshSlug = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`;

// Registration never dials the endpoint, so a closed local port is fine for
// the catalog-only scenarios.
const MCP_ENDPOINT = "http://127.0.0.1:59998/mcp";

scenario(
  "Auth methods · an MCP server can declare OAuth and an API key side by side",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);
    const slug = freshSlug("mcp_multiauth");

    yield* client.mcp.addServer({
      payload: {
        transport: "remote",
        name: "Multi-auth MCP",
        endpoint: MCP_ENDPOINT,
        slug,
        authenticationTemplate: [
          { kind: "oauth2" },
          { type: "apiKey", headers: { "X-Api-Key": ["Bearer ", variable("token")] } },
        ],
      },
    });

    yield* Effect.gen(function* () {
      const integration = yield* client.integrations.get({
        params: { slug: IntegrationSlug.make(slug) },
      });

      // Both methods project into the catalog (a slug-less single-header
      // apikey method gets the carrier-derived `header` slug), so the
      // connect flow can offer either and a connection binds one by slug.
      expect(
        integration.authMethods.map((m) => ({ kind: m.kind, template: m.template })),
        "the catalog lists both declared methods",
      ).toEqual([
        { kind: "oauth", template: "oauth2" },
        { kind: "apikey", template: "header" },
      ]);

      const apiKey = integration.authMethods.find((m) => m.kind === "apikey");
      expect(apiKey?.placements, "the API key method carries its header placement").toEqual([
        { carrier: "header", name: "X-Api-Key", prefix: "Bearer " },
      ]);
    }).pipe(
      Effect.ensuring(
        client.mcp
          .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);

scenario(
  "Auth methods · adding an API key method keeps a detected OAuth method",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);
    const slug = freshSlug("mcp_oauth_plus_key");

    // The add flow registered what the probe detected: OAuth only.
    yield* client.mcp.addServer({
      payload: {
        transport: "remote",
        name: "OAuth MCP",
        endpoint: MCP_ENDPOINT,
        slug,
        authenticationTemplate: [{ kind: "oauth2" }],
      },
    });

    yield* Effect.gen(function* () {
      // "+ Custom method" merge-appends — it must not displace OAuth.
      const configured = yield* client.mcp.configureAuth({
        params: { slug: IntegrationSlug.make(slug) },
        payload: {
          authenticationTemplate: [
            { type: "apiKey", headers: { "X-Api-Key": [variable("token")] } },
          ],
        },
      });
      expect(
        configured.authenticationTemplate.map((m) => m.kind),
        "the declared set now holds both methods",
      ).toEqual(["oauth2", "apikey"]);
      expect(
        configured.authenticationTemplate[1]?.slug,
        "the custom method gets its own custom_ slug",
      ).toMatch(/^custom_/);

      const integration = yield* client.integrations.get({
        params: { slug: IntegrationSlug.make(slug) },
      });
      expect(
        integration.authMethods.map((m) => m.kind),
        "the catalog offers OAuth and the API key",
      ).toEqual(["oauth", "apikey"]);
    }).pipe(
      Effect.ensuring(
        client.mcp
          .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);

scenario(
  "Auth methods · a no-auth MCP server can declare an API key method later",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);
    const slug = freshSlug("mcp_open_plus_key");

    // No declared auth — the server advertises nothing.
    yield* client.mcp.addServer({
      payload: { transport: "remote", name: "Open MCP", endpoint: MCP_ENDPOINT, slug },
    });

    yield* Effect.gen(function* () {
      const before = yield* client.integrations.get({
        params: { slug: IntegrationSlug.make(slug) },
      });
      expect(
        before.authMethods.map((m) => m.kind),
        "an open server starts with the no-auth method",
      ).toEqual(["none"]);

      yield* client.mcp.configureAuth({
        params: { slug: IntegrationSlug.make(slug) },
        payload: {
          authenticationTemplate: [
            { type: "apiKey", headers: { Authorization: ["Bearer ", variable("token")] } },
          ],
        },
      });

      const after = yield* client.integrations.get({
        params: { slug: IntegrationSlug.make(slug) },
      });
      expect(
        after.authMethods.map((m) => m.kind),
        "no-auth and the declared API key coexist",
      ).toEqual(["none", "apikey"]);
    }).pipe(
      Effect.ensuring(
        client.mcp
          .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);

scenario(
  "Auth methods · a GraphQL source registers multiple auth methods at add time",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);
    const slug = freshSlug("graphql_multiauth");

    yield* client.graphql.addIntegration({
      payload: {
        endpoint: "http://127.0.0.1:59998/graphql",
        slug,
        name: "Multi-auth GraphQL",
        authenticationTemplate: [
          { slug: "apiKey", type: "apiKey", headers: { "X-Api-Key": [variable("token")] } },
          { slug: "apikey-2", type: "apiKey", queryParams: { api_key: [variable("token")] } },
        ],
      },
    });

    yield* Effect.gen(function* () {
      const integration = yield* client.integrations.get({
        params: { slug: IntegrationSlug.make(slug) },
      });
      expect(
        integration.authMethods.map((m) => ({ template: m.template, kind: m.kind })),
        "both declared methods are in the catalog",
      ).toEqual([
        { template: "apiKey", kind: "apikey" },
        { template: "apikey-2", kind: "apikey" },
      ]);
      expect(
        integration.authMethods[1]?.placements,
        "the second method carries its query placement",
      ).toEqual([{ carrier: "query", name: "api_key", prefix: "" }]);
    }).pipe(
      Effect.ensuring(
        client.integrations
          .remove({ params: { slug: IntegrationSlug.make(slug) } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);

// ---------------------------------------------------------------------------
// THE EXTREME CASE — one source, four methods, three live connections, every
// invocation asserted against what the server actually received:
//   [oauth2]                              (declared; connect flow not exercised here)
//   [bearer header + team-id query]      (TWO inputs on ONE method)
//   [bearer header]                      (single input)
//   [auth-token query param]             (single input, the ui.sh shape)
// ---------------------------------------------------------------------------

scenario(
  "Auth methods · one source mixes oauth, a 2-input header+query method, a bearer header, and a query token",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = freshSlug("mcp_extreme");

      // A real MCP server that records every request it receives.
      const server = yield* serveMcpServer(() =>
        makeEchoMcpServer({
          name: "extreme-auth",
          toolName: "whoami",
          toolDescription: "Echoes a marker so the test can prove the invoke reached the server",
          inputName: "marker",
          text: (marker) => `ok:${marker}`,
        }),
      );

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Extreme auth MCP",
          endpoint: server.url,
          slug,
          authenticationTemplate: [
            { kind: "oauth2" },
            {
              slug: "token_and_team",
              type: "apiKey",
              headers: { Authorization: ["Bearer ", variable("api_token")] },
              queryParams: { team_id: [variable("team_id")] },
            },
            {
              slug: "bearer",
              type: "apiKey",
              headers: { Authorization: ["Bearer ", variable("token")] },
            },
            {
              slug: "query_token",
              type: "apiKey",
              queryParams: { auth_token: [variable("token")] },
            },
          ],
        },
      });

      yield* Effect.gen(function* () {
        // All four methods project into the catalog, the 2-input method with
        // both placements and their distinct variables (what drives the two
        // credential fields in the connect modal).
        const integration = yield* client.integrations.get({
          params: { slug: IntegrationSlug.make(slug) },
        });
        expect(
          integration.authMethods.map((m) => ({ kind: m.kind, template: m.template })),
          "the catalog lists all four methods",
        ).toEqual([
          { kind: "oauth", template: "oauth2" },
          { kind: "apikey", template: "token_and_team" },
          { kind: "apikey", template: "bearer" },
          { kind: "apikey", template: "query_token" },
        ]);
        expect(
          integration.authMethods[1]?.placements,
          "the 2-input method carries both placements with their variables",
        ).toEqual([
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "api_token" },
          { carrier: "query", name: "team_id", prefix: "", variable: "team_id" },
        ]);

        // One connection per credential method. The 2-input method takes a
        // `values` map (one entry per placement variable).
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("mixed"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("token_and_team"),
            values: { api_token: "tok_mixed", team_id: "team_42" },
          },
        });
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("bearer"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("bearer"),
            value: "tok_bearer",
          },
        });
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("token"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("query_token"),
            value: "tok_query",
          },
        });

        // Discovery dialed the server per connection; every connection
        // produced its own addressed tool.
        const tools = yield* client.tools.list({ query: {} });
        const names = tools
          .filter((tool) => String(tool.integration) === slug)
          .map((tool) => String(tool.address));
        for (const conn of ["mixed", "bearer", "token"]) {
          expect(names, `connection "${conn}" resolved the server's tool`).toContain(
            `tools.${slug}.org.${conn}.whoami`,
          );
        }

        // Invoke through the MCP surface (the real agent path: execute runs
        // sandbox code that calls the addressed tool), then assert the WIRE:
        // what the recording server received for each connection.
        const session = mcp.session(identity);

        const invokeAndCapture = (conn: string, marker: string) =>
          Effect.gen(function* () {
            const before = (yield* server.requests).length;
            const result = yield* session.call("execute", {
              // Return the whole result — the assertion only needs the echoed
              // marker to prove the call reached the server.
              code: `return JSON.stringify(await tools.${slug}.org.${conn}.whoami({ marker: ${JSON.stringify(marker)} }));`,
            });
            expect(result.text, `the ${conn} invocation reached the server`).toContain(
              `ok:${marker}`,
            );
            return (yield* server.requests).slice(before);
          });

        const mixedRequests = yield* invokeAndCapture("mixed", "m1");
        expect(
          mixedRequests.every((r) => r.authorization === "Bearer tok_mixed"),
          "the 2-input method rendered its bearer header",
        ).toBe(true);
        expect(
          mixedRequests.every((r) => r.url.includes("team_id=team_42")),
          "…and its team-id query param, from the second input",
        ).toBe(true);

        const bearerRequests = yield* invokeAndCapture("bearer", "b1");
        expect(
          bearerRequests.every((r) => r.authorization === "Bearer tok_bearer"),
          "the bearer method rendered only its header",
        ).toBe(true);
        expect(
          bearerRequests.every(
            (r) => !r.url.includes("team_id=") && !r.url.includes("auth_token="),
          ),
          "…with no query credential bleeding in from sibling methods",
        ).toBe(true);

        const queryRequests = yield* invokeAndCapture("token", "q1");
        expect(
          queryRequests.every((r) => r.url.includes("auth_token=tok_query")),
          "the query method rendered its token param",
        ).toBe(true);
        expect(
          queryRequests.every((r) => r.authorization === undefined),
          "…and no Authorization header",
        ).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            for (const name of ["mixed", "bearer", "token"]) {
              yield* client.connections
                .remove({
                  params: {
                    owner: "org",
                    integration: IntegrationSlug.make(slug),
                    name: ConnectionName.make(name),
                  },
                })
                .pipe(Effect.ignore);
            }
            yield* client.mcp
              .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
              .pipe(Effect.ignore);
          }),
        ),
      );
    }),
  ),
);
