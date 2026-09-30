// Cross-target: an OAuth connection's refresh grant can be run on demand.
//
// Refresh is lazy. A token is re-minted only when it is due or an upstream
// rejects it, so a connection nobody uses never spends its refresh token, and
// providers that expire refresh tokens after a period of inactivity kill it:
// the next call meets invalid_grant and the user has to reconnect in a
// browser. `POST /connections/:owner/:integration/:name/oauth/refresh` runs
// the grant now, however long the access token has left, which is what lets
// an operator keep an idle connection's refresh token exercised.
//
// The journey: an OpenAPI integration with a declared health check completes a
// real authorization-code flow against a live test AS that mints hour-long
// access tokens and rotates refresh tokens on every grant (forgetting the spent
// one). A health check leaves the token alone; the forced refresh reaches the
// token endpoint, reports the new expiry and a probed verdict, and a second
// forced refresh succeeds only because the rotated refresh token was stored.
// A connection whose grant the AS refuses reads `expired`, and is not re-sent.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer, type OAuthTestServerOptions } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const unique = (prefix: string) => `${prefix}${randomBytes(4).toString("hex")}`;

/** Upstream on 127.0.0.1 whose `GET /me` accepts any bearer the test AS
 *  minted, so a `healthy` verdict means the probe carried a real token. */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          const authorized = (request.headers["authorization"] ?? "").startsWith("Bearer at_");
          response.writeHead(authorized ? 200 : 401, {
            "content-type": "application/json",
          });
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
  oauth: {
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
  },
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

/** One integration with a declared health check, one OAuth client, and one
 *  connection completed through a real authorization-code flow. */
const connect = (
  client: Client,
  upstream: { readonly url: string },
  name: ConnectionName,
  serverOptions: OAuthTestServerOptions,
) =>
  Effect.gen(function* () {
    const oauth = yield* serveOAuthTestServer({
      scopes: ["identity.read"],
      ...serverOptions,
    });
    const slug = IntegrationSlug.make(unique("forcerefresh"));
    const clientSlug = OAuthClientSlug.make(unique("forcerefreshc"));

    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
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
    const candidates = yield* client.integrations.healthCheckCandidates({
      params: { slug },
    });
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
        name,
        integration: slug,
        template: AuthTemplateSlug.make("oauth"),
      },
    });
    expect(started.status, "oauth.start redirects to the authorization server").toBe("redirect");
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
      params: { owner: "org" as const, integration: slug, name },
      /** The refresh grants the authorization server actually received. */
      refreshGrants: oauth.requests.pipe(
        Effect.map((all) =>
          all.filter(
            (request) =>
              request.path === "/token" &&
              request.method === "POST" &&
              request.body.includes("grant_type=refresh_token"),
          ),
        ),
      ),
    };
  });

scenario(
  "Connections · an OAuth refresh can be forced before the access token is due",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();

      const live = yield* connect(client, upstream, ConnectionName.make("forcerefreshlive"), {
        tokenExpiresInSeconds: 3600,
      });

      // Baseline: with an hour left, nothing touches the refresh token.
      const before = yield* client.connections.checkHealth({
        params: live.params,
        query: {},
      });
      expect(before.status, "the fresh connection is healthy").toBe("healthy");
      expect(yield* live.refreshGrants, "a health check does not refresh a token not due").toEqual(
        [],
      );

      const forced = yield* client.connections.refreshOAuthToken({ params: live.params });
      expect(forced.refreshed, "the authorization server issued a new token").toBe(true);
      expect(forced.health.status, "the new token passes the declared probe").toBe("healthy");
      expect(forced.expiresAt ?? 0, "the new expiry is about an hour out").toBeGreaterThan(
        Date.now() + 30 * 60_000,
      );
      expect(yield* live.refreshGrants, "exactly one refresh grant was sent").toHaveLength(1);

      // The AS forgets a spent refresh token, so this grant succeeds only if
      // the rotated one from the first grant was stored.
      const again = yield* client.connections.refreshOAuthToken({ params: live.params });
      expect(again.refreshed, "the rotated refresh token was persisted").toBe(true);
      const grants = yield* live.refreshGrants;
      expect(grants).toHaveLength(2);
      const sent = grants.map((grant) => new URLSearchParams(grant.body).get("refresh_token"));
      expect(sent[1], "the second grant spent the rotated refresh token").not.toBe(sent[0]);

      // A grant the AS refuses is a verdict, and a dead grant is not re-sent.
      const refused = yield* connect(client, upstream, ConnectionName.make("forcerefreshdead"), {
        tokenExpiresInSeconds: 3600,
        supportRefresh: false,
        invalidRefreshTokenDescription: "Grant revoked",
      });
      const dead = yield* client.connections.refreshOAuthToken({ params: refused.params });
      expect(dead.refreshed, "no token was issued").toBe(false);
      expect(dead.health.status, "a refused grant reads expired, so the UI offers reconnect").toBe(
        "expired",
      );
      expect(dead.health.detail ?? "").toContain("Grant revoked");
      const deadAgain = yield* client.connections.refreshOAuthToken({ params: refused.params });
      expect(deadAgain.health.status).toBe("expired");
      expect(yield* refused.refreshGrants, "the dead grant was sent once").toHaveLength(1);
    }),
  ),
);
