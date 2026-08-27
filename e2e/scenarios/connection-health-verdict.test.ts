// Cross-target: a connection whose credential cannot be resolved is a health
// VERDICT, not a failed request — and the verdict is persisted, so the next
// surface to ask reads it instead of hammering the authorization server.
//
// Production symptom: a handful of connections whose authorization server had
// stopped re-minting credentials produced hundreds of server errors, every one
// of them on `/api/connections/.../health`, plus unbounded refresh traffic to
// the third party. A probe whose credential resolution failed escaped before
// the verdict was written, so nothing was ever persisted, the freshness gate
// had nothing to serve, and every mount of every surface sent another refresh
// grant to a server that was already refusing.
//
// The journey: an OpenAPI integration completes a real authorization-code flow
// against a live test AS that mints instantly-expiring access tokens and
// refuses every refresh grant. A health check is configured on the
// integration, so the connection takes the probing path. The probe cannot get
// a credential — and must answer with a verdict, persist it, and let a
// freshness window keep the next check off the wire. Both refusals are
// covered: a retryable one (`degraded`) and a dead grant (`expired`).
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
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}${randomBytes(4).toString("hex")}`;

/** Upstream on 127.0.0.1 whose `GET /me` is the obvious health probe. The
 *  credential never resolves in this scenario, so a request reaching here at
 *  all would mean the probe ran with no token — the 401 keeps that honest. */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          const authorized = (request.headers["authorization"] ?? "").startsWith("Bearer at_");
          response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
          response.end(JSON.stringify(authorized ? { email: "probe@example.test" } : {}));
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
    info: { title: "Identity API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/me": {
        get: {
          operationId: "getMe",
          summary: "The current account",
          security: [{ oauth: ["identity.read"] }],
          responses: { "200": { description: "account" } },
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
              scopes: { "identity.read": "Read the account" },
            },
          },
        },
      },
    },
  });

scenario(
  "Health checks · a connection whose refresh is refused reports a persisted verdict instead of failing the request",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();

      /** One integration with a declared health check, one OAuth client, one
       *  connection completed through a real authorization-code flow — against
       *  an authorization server that refuses every refresh grant in the given
       *  way. Instantly-expiring access tokens mean every credential
       *  resolution must refresh, so the refusal is what the probe meets. */
      const connectRefusing = (options: {
        readonly name: ConnectionName;
        readonly errorCode: string;
        readonly description: string;
      }) =>
        Effect.gen(function* () {
          const oauth = yield* serveOAuthTestServer({
            scopes: ["identity.read"],
            tokenExpiresInSeconds: 0,
            supportRefresh: false,
            invalidRefreshTokenErrorCode: options.errorCode,
            invalidRefreshTokenDescription: options.description,
          });
          const slug = IntegrationSlug.make(unique("healthverdict"));
          const clientSlug = OAuthClientSlug.make(unique("healthverdictc"));

          yield* Effect.addFinalizer(() =>
            Effect.all(
              [
                client.connections
                  .remove({ params: { owner: "org", integration: slug, name: options.name } })
                  .pipe(Effect.ignore),
                client.oauth
                  .removeClient({ params: { slug: clientSlug }, payload: { owner: "org" } })
                  .pipe(Effect.ignore),
                client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          );

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
                  scopes: ["identity.read"],
                },
              ],
            },
          });

          // Configure the probe, the way the user does in the editor: the
          // ranked candidates offer the identity GET, and picking it is what
          // sends this connection down the probing path.
          const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
          const getMe = candidates.find((candidate) => candidate.method === "get");
          if (!getMe) return yield* Effect.die("the identity spec exposed no GET candidate");
          yield* client.integrations.healthCheckSet({
            params: { slug },
            payload: { spec: { operation: getMe.operation, identityField: "email" } },
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
              originIntegration: slug,
            },
          });

          const started = yield* client.oauth.start({
            payload: {
              client: clientSlug,
              clientOwner: "org",
              owner: "org",
              name: options.name,
              integration: slug,
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
          yield* oauth.clearRequests;

          return {
            slug,
            /** Refresh grants the authorization server has actually received.
             *  This is the number the whole fix is about: probing must not
             *  scale with the number of surfaces asking. */
            refreshGrants: oauth.requests.pipe(
              Effect.map(
                (all) =>
                  all.filter(
                    (request) =>
                      request.path === "/token" &&
                      request.method === "POST" &&
                      request.body.includes("grant_type=refresh_token"),
                  ).length,
              ),
            ),
          };
        });

      // ── A refusal that is not "re-auth required" ────────────────────────
      // The AS answers the refresh with a code OTHER than invalid_grant, so
      // retrying could in principle work. This is the shape that used to
      // escape the probe as a server error.
      const degradedName = ConnectionName.make("healthverdictrefused");
      const refused = yield* connectRefusing({
        name: degradedName,
        errorCode: "invalid_request",
        description: "Refresh temporarily unavailable",
      });

      // THE guarantee: a probe that cannot resolve its credential answers with
      // a verdict. The request itself succeeds — a third party refusing a
      // refresh is not a defect in this product, and reporting it as one is
      // what buried the real signal.
      const probed = yield* client.connections.checkHealth({
        params: { owner: "org", integration: refused.slug, name: degradedName },
        query: {},
      });
      expect(
        probed.status,
        "a connection whose refresh is refused reads degraded, not a failed request",
      ).toBe("degraded");
      expect(
        probed.detail ?? "",
        "the verdict carries the authorization server's reason",
      ).toContain("Refresh temporarily unavailable");
      expect(yield* refused.refreshGrants, "the probe did try the refresh exactly once").toBe(1);

      // The verdict PERSISTS, so the accounts list shows the state at a glance
      // and the freshness gate has something to serve.
      const stored = yield* client.connections.get({
        params: { owner: "org", integration: refused.slug, name: degradedName },
      });
      expect(stored?.lastHealth?.status, "the verdict is persisted on the connection").toBe(
        "degraded",
      );
      expect(stored?.lastHealth?.checkedAt, "and it is the verdict this probe produced").toBe(
        probed.checkedAt,
      );

      // And repeated checks inside the freshness window — the window every
      // surface now sends for a non-healthy verdict — are served from that
      // persisted verdict: the authorization server sees nothing more.
      for (let mount = 0; mount < 3; mount++) {
        const remount = yield* client.connections.checkHealth({
          params: { owner: "org", integration: refused.slug, name: degradedName },
          query: { ifStaleMs: 30_000 },
        });
        expect(remount.status, "a repeat check inside the window keeps the verdict").toBe(
          "degraded",
        );
        expect(remount.checkedAt, "and it IS the persisted verdict, not a new probe").toBe(
          probed.checkedAt,
        );
      }
      expect(
        yield* refused.refreshGrants,
        "repeated checks inside the window never reach the authorization server again",
      ).toBe(1);

      // ── A dead grant ───────────────────────────────────────────────────
      // invalid_grant means the user must re-authenticate: a different verdict
      // through the same probing path, and it persists the same way.
      const expiredName = ConnectionName.make("healthverdictdead");
      const revoked = yield* connectRefusing({
        name: expiredName,
        errorCode: "invalid_grant",
        description: "Grant revoked",
      });

      const dead = yield* client.connections.checkHealth({
        params: { owner: "org", integration: revoked.slug, name: expiredName },
        query: {},
      });
      expect(dead.status, "a revoked grant reads expired, so the UI can offer reconnect").toBe(
        "expired",
      );
      expect(dead.detail ?? "", "the verdict carries the authorization server's reason").toContain(
        "Grant revoked",
      );
      const storedDead = yield* client.connections.get({
        params: { owner: "org", integration: revoked.slug, name: expiredName },
      });
      expect(storedDead?.lastHealth?.status, "the expired verdict is persisted too").toBe(
        "expired",
      );
    }),
  ),
);
