// Cross-target: an authorization server that refuses a scope-bearing refresh
// grant must not turn a live refresh token into a dead connection.
//
// Railway answers any refresh grant carrying a `scope` parameter with
// `invalid_scope: refresh token missing requested scope` when the refresh
// token's own record is narrower than the authorization response it echoed
// back (issue #1969). Echoing the recorded grant is legal under RFC 6749 §6,
// and so is omitting `scope`, which the spec defines as "the scope originally
// granted". Before the fallback, the refusal reached the sandbox as
// `oauth_refresh_failed` with `retryable: false`, so a connection whose refresh
// token was perfectly alive stayed unusable until someone re-authorized it by
// hand — the reported symptom was a saved Railway connection failing every
// call.
//
// The journey: an OpenAPI integration completes a real authorization-code flow
// against a live test AS that mints instantly-expiring access tokens and holds
// a narrower grant on the refresh token than the authorization echoed. The
// first tool call must therefore refresh, the scope-bearing grant is refused,
// executor retries WITHOUT `scope`, and the call succeeds — proven from the
// AS's own request ledger, which records both the refused request and the
// accepted retry.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

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

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** Upstream on 127.0.0.1: `GET /issues` is 200 for any bearer and returns one
 *  issue, so "the call succeeded" is distinguishable from "the call returned
 *  an empty body". */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith("/issues")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ issues: [{ id: "issue-1", title: "Scope drift" }] }));
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
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

const spec = (
  baseUrl: string,
  oauth: { readonly authorizationEndpoint: string; readonly tokenEndpoint: string },
): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Issues API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/issues": {
        get: {
          operationId: "listIssues",
          summary: "List issues",
          security: [{ oauth: ["issues.read"] }],
          responses: { "200": { description: "issues" } },
        },
      },
    },
    components: {
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: { "issues.read": "Read issues", "issues.write": "Write issues" },
            },
          },
        },
      },
    },
  });

const invokeByAddressCode = (address: string, args: unknown) => `
const segments = ${JSON.stringify(address)}.split(".").slice(1);
let node = tools;
for (const segment of segments) node = node[segment];
const result = await node(${JSON.stringify(args)});
return JSON.stringify(result);
`;

type ToolEnvelope = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
};

scenario(
  "Auth failures · a refresh refused for its scope is retried without one, so a scope-drifted connection keeps working",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();
      // The AS grants both scopes at authorization and echoes them, but the
      // refresh token it stores covers only `issues.read` — the divergence
      // that makes the recorded grant look like a request for more access.
      const oauth = yield* serveOAuthTestServer({
        scopes: ["issues.read", "issues.write"],
        refreshGrantScopes: ["issues.read"],
        tokenExpiresInSeconds: 0,
      });
      const slug = unique("refreshscope");
      const clientSlug = OAuthClientSlug.make(unique("refreshscopec"));

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: spec(upstream.url, oauth) },
              slug,
              baseUrl: upstream.url,
              authenticationTemplate: [
                {
                  slug: "oauth",
                  kind: "oauth2",
                  authorizationUrl: oauth.authorizationEndpoint,
                  tokenUrl: oauth.tokenEndpoint,
                  scopes: ["issues.read", "issues.write"],
                },
              ],
            },
          });
          yield* client.oauth.createClient({
            payload: {
              owner: "org",
              slug: clientSlug,
              grant: "authorization_code",
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              clientId: "test-client",
              clientSecret: "test-secret",
              originIntegration: IntegrationSlug.make(slug),
            },
          });

          const started = yield* client.oauth.start({
            payload: {
              client: clientSlug,
              clientOwner: "org",
              owner: "org",
              name: ConnectionName.make("main"),
              integration: IntegrationSlug.make(slug),
              template: AuthTemplateSlug.make("oauth"),
            },
          });
          expect(started.status, "oauth.start redirects to the authorization server").toBe(
            "redirect",
          );
          if (started.status !== "redirect") return yield* Effect.die("no redirect");

          // Drive the test IdP's consent by hand (authorize → login → code).
          const code = yield* Effect.promise(async () => {
            const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
            const loginUrl = authorize.headers.get("location");
            if (!loginUrl) throw new Error(`authorize did not redirect: ${authorize.status}`);
            const login = await fetch(loginUrl, {
              method: "POST",
              headers: {
                authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
              },
              redirect: "manual",
            });
            const callbackUrl = login.headers.get("location");
            if (!callbackUrl) throw new Error(`login did not redirect: ${login.status}`);
            const minted = new URL(callbackUrl).searchParams.get("code");
            if (!minted) throw new Error("callback carried no authorization code");
            return minted;
          });
          yield* client.oauth.complete({ payload: { state: started.state, code } });

          const tools = yield* client.tools.list({ query: {} });
          const address = tools
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address))
            .find((addr) => addr.endsWith("listIssues"));
          expect(address, "the listIssues tool is in the catalog").toBeDefined();

          // Call through the real MCP surface, the channel the reported
          // failure was seen on.
          const session = mcp.session(identity);
          let called = yield* session.call("execute", {
            code: invokeByAddressCode(address!, {}),
          });
          // Approval-gated tools pause the execution once per gated call.
          let guard = 0;
          while (called.text.includes("executionId:") && guard < 10) {
            called = yield* session.approvePaused(called.text);
            guard += 1;
          }
          expect(
            called.ok,
            `the MCP execute call itself completed (got: ${called.text.slice(0, 400)})`,
          ).toBe(true);
          const envelope = JSON.parse(called.text) as ToolEnvelope;

          // THE guarantee: the caller gets data, not `oauth_refresh_failed`.
          // The access token had already expired, so this call could only
          // succeed by refreshing.
          expect(
            envelope.ok,
            `the tool call succeeded (got: ${JSON.stringify(envelope.error ?? {}).slice(0, 400)})`,
          ).toBe(true);
          expect(
            JSON.stringify(envelope.data ?? {}),
            "the upstream's payload came back, so the retried token really worked upstream",
          ).toContain("issue-1");

          // Proven from the AS's own ledger: the scope-bearing grant was
          // refused, and the scope-less retry is what succeeded.
          const refreshGrants = (yield* oauth.requests).filter(
            (request) =>
              request.path === "/token" &&
              request.method === "POST" &&
              request.body.includes("grant_type=refresh_token"),
          );
          expect(
            refreshGrants.length,
            "the refused refresh and the retry are both on the ledger (2 requests)",
          ).toBe(2);
          const refused = refreshGrants[0]!;
          const retried = refreshGrants[1]!;
          expect(
            new URLSearchParams(refused.body).get("scope"),
            "the first refresh echoed the grant the connection recorded",
          ).toBe("issues.read issues.write");
          expect(
            new URLSearchParams(retried.body).has("scope"),
            "the retry omitted scope, the form RFC 6749 §6 defines as 'the grant originally issued'",
          ).toBe(false);
          expect(
            new URLSearchParams(retried.body).get("refresh_token"),
            "the retry replayed the same still-live refresh token",
          ).toBe(new URLSearchParams(refused.body).get("refresh_token"));
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({
              params: {
                owner: "org",
                integration: IntegrationSlug.make(slug),
                name: ConnectionName.make("main"),
              },
            })
            .pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({ params: { slug: clientSlug }, payload: { owner: "org" } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
