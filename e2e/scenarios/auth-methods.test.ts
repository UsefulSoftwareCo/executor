// Cross-target: multi-method authentication — an integration declares SEVERAL
// auth methods and a connection picks one by template slug. Covers the model
// rework: MCP's slugged `authenticationTemplate` array, the merge-append
// configureAuth flow (a custom API key must never displace a detected OAuth
// method), declaring a method on a server that advertises none, and GraphQL's
// multi-method add. Entirely through the typed clients — no MCP server is
// dialed (registration and method configuration are catalog statements).
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";

const api = composePluginApi([mcpHttpPlugin(), graphqlHttpPlugin()] as const);

const freshSlug = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

// Registration never dials the endpoint, so a closed local port is fine.
const MCP_ENDPOINT = "http://127.0.0.1:59998/mcp";

scenario(
  "Auth methods · an MCP server can declare OAuth and an API key side by side",
  { needs: ["api"] },
  (ctx) =>
    Effect.gen(function* () {
      const identity = yield* ctx.target.newIdentity();
      const client = yield* ctx.api.client(api, identity);
      const slug = freshSlug("mcp-multiauth");

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Multi-auth MCP",
          endpoint: MCP_ENDPOINT,
          slug,
          authenticationTemplate: [
            { kind: "oauth2" },
            { kind: "header", headerName: "X-Api-Key", prefix: "Bearer " },
          ],
        },
      });

      yield* Effect.gen(function* () {
        const integration = yield* client.integrations.get({
          params: { slug: IntegrationSlug.make(slug) },
        });

        // Both methods project into the catalog, slugged by kind, so the
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
  { needs: ["api"] },
  (ctx) =>
    Effect.gen(function* () {
      const identity = yield* ctx.target.newIdentity();
      const client = yield* ctx.api.client(api, identity);
      const slug = freshSlug("mcp-oauth-plus-key");

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
            authenticationTemplate: [{ kind: "header", headerName: "X-Api-Key" }],
          },
        });
        expect(
          configured.authenticationTemplate.map((m) => m.kind),
          "the declared set now holds both methods",
        ).toEqual(["oauth2", "header"]);
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
  { needs: ["api"] },
  (ctx) =>
    Effect.gen(function* () {
      const identity = yield* ctx.target.newIdentity();
      const client = yield* ctx.api.client(api, identity);
      const slug = freshSlug("mcp-open-plus-key");

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
              { kind: "header", headerName: "Authorization", prefix: "Bearer " },
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
  { needs: ["api"] },
  (ctx) =>
    Effect.gen(function* () {
      const identity = yield* ctx.target.newIdentity();
      const client = yield* ctx.api.client(api, identity);
      const slug = freshSlug("graphql-multiauth");

      yield* client.graphql.addIntegration({
        payload: {
          endpoint: "http://127.0.0.1:59998/graphql",
          slug,
          name: "Multi-auth GraphQL",
          authenticationTemplate: [
            { kind: "apiKey", slug: "apiKey", in: "header", name: "X-Api-Key" },
            { kind: "apiKey", slug: "apikey-2", in: "query", name: "api_key" },
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
