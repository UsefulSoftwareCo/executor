/**
 * Services such as GitLab and Yahoo ask for the sign-in's callback again when a token is
 * refreshed. A grant keeps the callback its sign-in used and sends it on every refresh. A grant an
 * earlier release saved has none, and refreshes as it did before, without one.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Published = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Link = Schema.Struct({ connection: Schema.String, url: Schema.String });
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  value: Schema.Struct({ service: Schema.Struct({ refreshed: Schema.Boolean }) }),
});
const StoredResponse = Schema.Struct({ response: Schema.Record(Schema.String, Schema.Json) });

layer(TestLive, { excludeTestServices: true })("OAuth refresh redirect URI", (it) => {
  it.effect(scenarios.oauthRefreshRedirectUri.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          http = yield* HttpClient.HttpClient,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const issuer = yield* oauthSetupIssuer;
        const client = {
          clientId: "synthetic-redirect-client",
          clientSecret: "synthetic-redirect-secret",
        };
        // Tokens are issued inside the host's renewal window, so using the account refreshes it.
        yield* issuer.configure({ refreshTokens: true, expiresIn: 20, registeredClient: client });
        const name = `Refresh callback ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
  tools: router({
    read: query({ input: object({}) }, async ({ fetch }) => ({ service: await (await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } })).json() })),
  }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Published, deployed);
        let account: string | undefined;
        // A legacy storage write leaves the product stopped, so start it before cleaning up.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* serverControl("start");
            yield* api.request(agent, "DELETE", `/v1/apps/${app.id}`);
            if (account !== undefined)
              yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const link = yield* body(
          Link,
          yield* api.request(agent, "POST", "/account-connect/api/requests", {
            owner: "local",
            target: { app: app.id, requirement: "service" },
          }),
        );
        const grant = {
          connection: link.connection,
          token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("token"),
        };
        const started = yield* api.request(session, "POST", "/account-connect/api/oauth/start", {
          ...grant,
          method: "oauth",
          label: "Synthetic refresh callback account",
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const { authorizationUrl } = yield* body(Redirect, started);
        const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri");
        if (redirectUri === null) return yield* Effect.die("Sign-in sent no redirect_uri");
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
            expect(consent.status).toBe(302);
            const location = consent.headers.location;
            if (location === undefined)
              return yield* Effect.die("Issuer did not return a callback");
            return location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          session,
          "POST",
          "/account-connect/api/oauth/complete",
          { ...grant, callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const connected = (yield* body(Resource, completed)).id;
        account = connected;

        const read = Effect.gen(function* () {
          const before = (yield* issuer.metrics).refreshesIssued;
          const response = yield* api.request(agent, "POST", "/v1/tools/call", {
            app: app.id,
            tool: "read",
            input: {},
          });
          const metrics = yield* issuer.metrics;
          expect(
            response.status,
            `${JSON.stringify(response.body)}, checks=${JSON.stringify(metrics.refreshChecks)}`,
          ).toBe(200);
          expect((yield* body(Completed, response)).value.service.refreshed).toBe(true);
          expect(metrics.refreshesIssued).toBeGreaterThan(before);
          return metrics;
        });

        // The service refuses a refresh that does not repeat the sign-in's callback.
        yield* issuer.configure({ requireRefreshRedirectUri: redirectUri });
        expect((yield* read).refreshRedirectUri).toBe(redirectUri);

        // An earlier release saved the grant without its callback, with a refresh token the
        // service issued at sign-in and an access token that is due for renewal.
        const registration = (yield* issuer.metrics).lastRegistration;
        if (registration === undefined) return yield* Effect.die("Sign-in registered no client");
        const refreshToken = yield* issuer.issueRefreshToken(client.clientId);
        const [stored = []] = yield* legacyStorage([
          {
            sql: `SELECT p.definition->'auth'->'oauth'->'response' AS response
              FROM executor_providers p JOIN executor_accounts a ON a.provider = p.id
              WHERE a.id = $1`,
            params: [connected],
          },
        ]);
        const [{ response }] = Schema.decodeUnknownSync(Schema.Tuple([StoredResponse]))(stored);
        yield* legacyStorage([
          {
            sql: `UPDATE executor_oauth_grants SET encrypted = $2 WHERE id = $1`,
            params: [
              connected,
              {
                sealed: {
                  id: connected,
                  value: {
                    server: {
                      issuer: issuer.origin,
                      authorization_endpoint: `${issuer.origin}/authorize`,
                      token_endpoint: `${issuer.origin}/token`,
                    },
                    client: {
                      client_id: client.clientId,
                      token_endpoint_auth_method: registration.method,
                      ...(registration.method === "none"
                        ? {}
                        : { client_secret: client.clientSecret }),
                    },
                    response,
                    fields: { access_token: "synthetic-access-token", token_type: "Bearer" },
                    refreshToken,
                    expiresAt: Date.now(),
                  },
                },
              },
            ],
          },
        ]);
        // The service accepts a refresh without a callback, as RFC 6749 section 6 defines it.
        yield* issuer.configure({ requireRefreshRedirectUri: null });
        yield* serverControl("start");
        expect((yield* read).refreshRedirectUri).toBeNull();
      }),
    ),
  );
});
