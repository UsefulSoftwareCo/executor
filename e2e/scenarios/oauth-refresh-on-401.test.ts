// Cross-target: when the upstream rejects a token executor still believes is
// valid, executor re-mints it and retries — the caller never sees the 401.
//
// `expires_at` only ever holds the authorization server's ADVERTISED lifetime.
// A token can stop working well before that: server-side revocation, an
// identity provider idle-timeout policy shorter than the token lifetime, or an
// AS that never advertised an expiry at all. Before the reactive path, the
// proactive expiry check was the only thing that triggered a refresh, so every
// one of those cases surfaced to the user as "re-authenticate" even though the
// stored refresh token would have worked.
//
// The journey: an OpenAPI integration completes a real authorization-code flow
// against a live test AS that issues LONG-LIVED tokens (so the proactive check
// never fires). The upstream then revokes the bearer it was given. The next
// tool call gets a 401, executor re-mints against the AS, retries with the new
// token, and the call succeeds — proven from the upstream's own request ledger,
// which records both the rejected bearer and the accepted one.
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

type UpstreamHandle = {
  readonly url: string;
  /** Every bearer the upstream saw, oldest first — the evidence that a retry
   *  happened and that it carried a DIFFERENT token than the rejected call. */
  readonly bearers: () => readonly string[];
  /** Stop honouring the bearer(s) seen so far, exactly as a revocation or an
   *  idle-timeout policy would. Anything minted afterwards still works. */
  readonly revokeSeenBearers: () => void;
  readonly close: () => void;
};

/** Upstream on 127.0.0.1 that authenticates for real: `GET /issues` is 200 for
 *  any bearer it has not been told to reject, and 401 for one it has. */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<UpstreamHandle>((resume) => {
      const seen: string[] = [];
      const revoked = new Set<string>();
      const server = createServer((request, response) => {
        const bearer = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (request.method === "GET" && (request.url ?? "").startsWith("/issues")) {
          seen.push(bearer);
          if (revoked.has(bearer)) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_token" }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ issues: [{ id: 1, title: "first" }] }));
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
            bearers: () => [...seen],
            revokeSeenBearers: () => {
              for (const bearer of seen) revoked.add(bearer);
            },
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
              scopes: { "issues.read": "Read issues" },
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
    readonly status?: number;
  };
};

scenario(
  "Auth failures · a token the upstream rejects is re-minted and the call retried, so a revoked credential recovers without a reconnect",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();
      // LONG-LIVED tokens are the point: the proactive expiry check must never
      // fire, so the only thing that can trigger a refresh here is the
      // upstream's 401. Refresh support is on, so the re-mint can succeed.
      const oauth = yield* serveOAuthTestServer({
        scopes: ["issues.read"],
        tokenExpiresInSeconds: 3600,
      });
      const slug = unique("refresh401");
      const clientSlug = OAuthClientSlug.make(unique("refresh401c"));

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
                  scopes: ["issues.read"],
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

          const session = mcp.session(identity);
          const call = (): Effect.Effect<ToolEnvelope, unknown> =>
            Effect.gen(function* () {
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
              return JSON.parse(called.text) as ToolEnvelope;
            });

          // Baseline: the connection works, and the upstream records the bearer.
          const first = yield* call();
          expect(first.ok, "the first call succeeds on the freshly minted token").toBe(true);
          const bearersAfterFirst = upstream.bearers();
          expect(bearersAfterFirst.length, "the upstream saw exactly one call").toBe(1);

          // Revoke it upstream. Executor's stored `expires_at` still says this
          // token is good for an hour — the divergence this whole path exists
          // for. Nothing in executor's state changes here.
          upstream.revokeSeenBearers();

          const second = yield* call();

          // THE guarantee: the caller sees a successful call, not a 401 and not
          // a re-authenticate wall. Executor absorbed the rejection by
          // re-minting and retrying.
          expect(
            second.ok,
            `the call succeeded after the upstream rejected the stored token (got: ${JSON.stringify(second.error ?? {}).slice(0, 400)})`,
          ).toBe(true);

          // Proven from the upstream's own ledger: the retry really happened,
          // and it carried a DIFFERENT bearer than the one that was rejected.
          const bearers = upstream.bearers();
          expect(bearers.length, "the upstream saw the rejected call and the retry (3 total)").toBe(
            3,
          );
          const rejected = bearers[1]!;
          const retried = bearers[2]!;
          expect(rejected, "the second call reused the token the upstream had revoked").toBe(
            bearersAfterFirst[0],
          );
          expect(retried, "the retry carried a freshly minted token").not.toBe(rejected);
          expect(
            yield* oauth.acceptsAccessToken(retried),
            "the retry's token is one the authorization server actually issued",
          ).toBe(true);

          // A refresh grant really was redeemed — not a silent reuse of
          // something already cached.
          const refreshGrants = (yield* oauth.requests).filter(
            (request) =>
              request.path === "/token" &&
              request.method === "POST" &&
              request.body.includes("grant_type=refresh_token"),
          );
          expect(refreshGrants.length, "exactly one refresh grant was redeemed").toBe(1);
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
