// Selfhost-only: two MCP sessions that hit an expired token at the same moment
// must share ONE refresh-token grant, never race two.
//
// Issue #1520: the in-flight refresh gate lived inside a single execution
// stack, but the self-host builds a fresh stack per MCP session, so each
// session believed it was the refresh winner and redeemed the same stored
// refresh token. Providers that rotate refresh tokens answer the second
// redemption with `invalid_grant: refresh token reuse detected` and may revoke
// the whole token family — the connection dies and the user must reauthorize.
// The first refresh cycle succeeds, so the bug stays invisible until a later
// expiry.
//
// The journey: an OpenAPI integration completes a real authorization-code flow
// against a live test authorization server; the upstream then rejects both
// sessions' first call with a 401 at the same instant (it holds both requests
// until both have arrived, so the contention is forced rather than left to the
// scheduler); and the authorization server's own request ledger proves exactly
// one refresh grant was issued and both retries carried the same new bearer.
import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

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

/** Both sessions call once, are rejected together, then retry once. */
const SESSIONS = 2;

type UpstreamHandle = {
  readonly url: string;
  readonly bearers: () => readonly string[];
  readonly close: () => void;
};

/**
 * Upstream that rejects the whole first wave at once.
 *
 * The barrier is the point: it holds every session's first call until all have
 * arrived, then 401s them together, which forces both sessions into a genuinely
 * simultaneous refresh instead of hoping the scheduler interleaves them.
 */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<UpstreamHandle>((resume) => {
      const bearers: string[] = [];
      const held: ServerResponse[] = [];
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith("/issues")) {
          bearers.push((request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
          if (held.length < SESSIONS) {
            held.push(response);
            if (held.length === SESSIONS) {
              for (const rejected of held) {
                rejected.writeHead(401, { "content-type": "application/json" });
                rejected.end(JSON.stringify({ error: "invalid_token" }));
              }
            }
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ issues: [] }));
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
            bearers: () => [...bearers],
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

const invokeByAddressCode = (address: string) => `
const segments = ${JSON.stringify(address)}.split(".").slice(1);
let node = tools;
for (const segment of segments) node = node[segment];
const result = await node({});
return JSON.stringify(result);
`;

const completeAuthorization = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const authorize = await fetch(authorizationUrl, { redirect: "manual" });
    const loginUrl = authorize.headers.get("location");
    if (!loginUrl) return null;
    const login = await fetch(loginUrl, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("alice:password").toString("base64")}` },
      redirect: "manual",
    });
    const callbackUrl = login.headers.get("location");
    if (!callbackUrl) return null;
    return new URL(callbackUrl).searchParams.get("code");
  });

scenario(
  "OAuth refresh · separate MCP sessions share one rotating-token refresh grant",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();
      const oauth = yield* serveOAuthTestServer({ scopes: ["issues.read"] });
      const slug = unique("refreshcrosssession");
      const clientSlug = OAuthClientSlug.make(unique("refreshcrosssessionc"));

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
          const code = yield* completeAuthorization(started.authorizationUrl);
          expect(code, "the authorization server issued a callback code").toBeDefined();
          if (code == null) return yield* Effect.die("no authorization code");
          yield* client.oauth.complete({ payload: { state: started.state, code } });

          const address = (yield* client.tools.list({ query: {} }))
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address))
            .find((tool) => tool.endsWith("listIssues"));
          expect(address, "the OAuth-protected tool is in the catalog").toBeDefined();
          if (!address) return yield* Effect.die("no listIssues tool");
          yield* oauth.clearRequests;

          const sessions = Array.from({ length: SESSIONS }, () => mcp.session(identity));
          const call = (session: (typeof sessions)[number]) =>
            Effect.gen(function* () {
              let result = yield* session.call("execute", { code: invokeByAddressCode(address) });
              let approvals = 0;
              while (result.text.includes("executionId:") && approvals < 10) {
                result = yield* session.approvePaused(result.text);
                approvals += 1;
              }
              // Without a shared gate the loser redeems a retired refresh token
              // and the authorization server answers invalid_grant, so this is
              // the assertion that carries the user-visible failure.
              expect(result.ok, `MCP execute completed: ${result.text.slice(0, 400)}`).toBe(true);
            });

          yield* Effect.all(sessions.map(call), { concurrency: "unbounded" });

          const refreshGrants = (yield* oauth.requests).filter(
            (request) =>
              request.path === "/token" && request.body.includes("grant_type=refresh_token"),
          );
          expect(refreshGrants, "both sessions joined one refresh grant").toHaveLength(1);
          const bearers = upstream.bearers();
          expect(bearers, "both rejected calls retried after the refresh").toHaveLength(
            SESSIONS * 2,
          );
          expect(bearers[2], "the first retry used a new bearer").not.toBe(bearers[0]);
          expect(bearers[3], "both retries used the refreshed bearer").toBe(bearers[2]);
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
