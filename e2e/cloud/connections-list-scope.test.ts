// Cloud: `connections.list` over the MCP surface returns a LEAN projection. A
// single OAuth connection's `oauthScope` grant string runs to thousands of
// characters for a real provider, and an agent listing connections to pick one
// pays that cost on every row. So the core tool summarizes scope to an
// `oauthScopeCount` by default and only echoes the full grant string when the
// caller asks for `verbose: true`.
//
// Proven end to end: a real authorization-code flow (start → consent →
// complete) mints a connection carrying a recorded `read` scope, then the core
// tool is driven through `execute` exactly as an MCP client (Claude, Cursor, …)
// would call it. The HTTP API projection is deliberately untouched — the web
// console reads the full `oauthScope` to flag reconnect-for-new-scope — so this
// only pins the agent-facing tool.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** Run `execute` and parse the sandbox's JSON return value. */
const executeJson = (session: McpSession, code: string) =>
  Effect.gen(function* () {
    const result = yield* session.call("execute", { code });
    expect(result.ok, `execute completed (got: ${result.text.slice(0, 400)})`).toBe(true);
    return JSON.parse(result.text) as Record<string, unknown>;
  });

/** The `main` connection from a `connections.list` sandbox return value. */
const mainConnection = (listed: Record<string, unknown>): Record<string, unknown> | undefined => {
  const connections = (listed as { connections?: ReadonlyArray<Record<string, unknown>> })
    .connections;
  return connections?.find((c) => c.name === "main");
};

const listCode = (integration: string, verbose: boolean) => `
const res = await tools.executor.coreTools.connections.list(${JSON.stringify(
  verbose ? { integration, verbose: true } : { integration },
)});
return res.ok ? res.data : res;
`;

scenario(
  "Connections · list summarizes OAuth scope to a count by default and returns the full grant under verbose",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;
      const oauth = yield* serveOAuthTestServer({ scopes: ["read"] });
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const session = mcp.session(identity);

      // An integration declaring an oauth template — the minted connection
      // attaches to it and records the granted `read` scope.
      const integration = IntegrationSlug.make(unique("connscopeint"));
      yield* client.openapi.addSpec({
        payload: {
          spec: {
            kind: "blob",
            value: JSON.stringify({
              openapi: "3.0.3",
              info: { title: "OAuth-protected API", version: "1.0.0" },
              paths: {
                "/me": {
                  get: {
                    operationId: "getMe",
                    tags: ["default"],
                    responses: { "200": { description: "the caller" } },
                  },
                },
              },
            }),
          },
          slug: integration,
          baseUrl: "http://127.0.0.1:59999",
          authenticationTemplate: [
            {
              slug: "oauth",
              kind: "oauth2",
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: ["read"],
            },
          ],
        },
      });

      const clientSlug = OAuthClientSlug.make(unique("connscopec"));
      yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug: clientSlug,
          authorizationUrl: oauth.authorizationEndpoint,
          tokenUrl: oauth.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        },
      });

      const started = yield* client.oauth.start({
        payload: {
          client: clientSlug,
          clientOwner: "org",
          owner: "org",
          name: ConnectionName.make("main"),
          integration,
          template: AuthTemplateSlug.make("oauth"),
        },
      });
      if (started.status !== "redirect") {
        throw new Error(`oauth.start did not redirect: ${JSON.stringify(started)}`);
      }

      // Headless consent: the authorize page bounces to login, and submitting
      // credentials redirects back to the product callback with a code.
      const authorize = yield* Effect.promise(() =>
        fetch(started.authorizationUrl, { redirect: "manual" }),
      );
      const consent = yield* Effect.promise(() =>
        fetch(authorize.headers.get("location") ?? "", {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
          },
        }),
      );
      const callback = new URL(consent.headers.get("location") ?? "");
      const code = callback.searchParams.get("code") ?? "";
      yield* client.oauth.complete({ payload: { state: started.state, code } });

      // Default (lean): the full scope string is omitted; a grant count stands
      // in so a scanning agent still knows scope exists and how much.
      const lean = yield* executeJson(session, listCode(String(integration), false));
      const leanMain = mainConnection(lean);
      expect(leanMain, "the minted connection is listed").toBeDefined();
      expect(leanMain?.oauthScopeCount, "scope is summarized to its grant count").toBe(1);
      expect(
        "oauthScope" in (leanMain ?? {}),
        "the full scope grant string is omitted by default",
      ).toBe(false);

      // verbose: the full grant string is included alongside the count.
      const verbose = yield* executeJson(session, listCode(String(integration), true));
      const verboseMain = mainConnection(verbose);
      expect(verboseMain?.oauthScope, "verbose returns the full grant string").toBe("read");
      expect(verboseMain?.oauthScopeCount, "the count still accompanies the full scope").toBe(1);
    }),
  ),
);
