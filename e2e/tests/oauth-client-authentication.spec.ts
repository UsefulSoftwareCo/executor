/**
 * Token endpoint client authentication against services shaped like real providers: Notion
 * accepts only HTTP Basic, Google and PlanetScale (Doorkeeper) compare Basic credentials without
 * form-decoding them, and HubSpot reads client credentials only from the request body. A client
 * entered by hand keeps Basic even where discovery advertises both forms. Client IDs
 * and secrets carry the `-`, `_` and `.` those services issue.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const Read = Schema.Struct({ refreshed: Schema.Boolean });
const googleClient = {
  clientId: "123456-abc.apps.googleusercontent.com",
  clientSecret: "GOCSPX-a_b.c",
};
const notionClient = {
  clientId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  clientSecret: "secret_Ab-c_D.e",
};
const hubspotClient = {
  clientId: "5f0c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5",
  clientSecret: "0a1b2c3d-4e5f-6a7b-8c9d-e0f1a2b3c4d5",
};
const doorkeeperClient = {
  clientId: "pscale_app_Xk2-9aB.c_Q",
  clientSecret: "pscale_oauth_secret_9f-a_b.c",
};

layer(HostedLive, { excludeTestServices: true })("OAuth client authentication", (it) => {
  it.effect(scenarios.oauthClientAuthentication.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // Tokens are issued inside the host's renewal window, so using the account refreshes it.
        yield* issuer.configure({ refreshTokens: true, expiresIn: 20, revocation: "recorded" });

        const deploy = (name: string, config: object) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service=defineProvider({name:${JSON.stringify(name)},auth:{oauth:oauth2(${JSON.stringify(config)})}});
export default defineApp({accounts:{service}},async({accounts})=>({tools:router({read:query({input:object({})},async({fetch})=>{const result=await fetch(${JSON.stringify(`${issuer.origin}/resource`)},{headers:{authorization:"Bearer "+accounts.service.fields.access_token}});return result.json();})})}));`,
                },
                appsManifest,
              ],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(Resource, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const declared = (name: string, tokenEndpointAuthMethod?: string) =>
          deploy(name, {
            authorizationUrl: `${issuer.origin}/authorize`,
            tokenUrl: `${issuer.origin}/token`,
            revocationUrl: `${issuer.origin}/revoke`,
            scopes: ["read"],
            ...(tokenEndpointAuthMethod === undefined ? {} : { tokenEndpointAuthMethod }),
          });

        /**
         * Sign in through the real start, consent and callback boundaries, renew the tokens by
         * using the account, then delete it and read the revocation the deletion sent.
         * A client entered by hand is posted exactly as the account form submits it.
         */
        const lifecycle = (
          app: typeof Resource.Type,
          client?: {
            readonly clientId: string;
            readonly clientSecret: string;
            readonly methods?: readonly ("client_secret_basic" | "client_secret_post")[];
          },
        ) =>
          Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              {
                method: "oauth",
                label: "Client authentication",
                ...(client === undefined
                  ? {}
                  : { client: { clientId: client.clientId, clientSecret: client.clientSecret } }),
              },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const redirect = yield* body(Redirect, started);
            if (client !== undefined)
              yield* issuer.allowClient({ ...client, redirect: redirect.redirectUri });
            const callbackUrl = yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(redirect.authorizationUrl);
                expect(consent.status).toBe(302);
                const location = consent.headers.location;
                if (location === undefined)
                  return yield* Effect.die("Issuer did not return a callback");
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/complete`,
              { callbackUrl },
            );
            const exchanged = yield* issuer.metrics;
            expect(
              completed.status,
              `${JSON.stringify(completed.body)}, checks=${JSON.stringify(exchanged.tokenChecks)}`,
            ).toBe(200);
            const account = yield* body(Resource, completed);

            const refreshes = exchanged.refreshes;
            const read = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/apps/${app.id}/tools/call`,
              { profile: profile.id, tool: "read", kind: "query", input: {} },
            );
            const renewed = yield* issuer.metrics;
            expect(
              read.status,
              `${JSON.stringify(read.body)}, checks=${JSON.stringify(renewed.refreshChecks)}`,
            ).toBe(200);
            expect(yield* body(Read, read)).toEqual({ refreshed: true });
            expect(renewed.refreshes).toBeGreaterThan(refreshes);

            const revocations = renewed.revocations.length;
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`))
                .status,
            ).toBe(200);
            // Revocation runs after the response, so wait for the issuer to observe it.
            const revocation = yield* issuer.metrics.pipe(
              Effect.flatMap((metrics) => {
                const received = metrics.revocations[revocations];
                return received === undefined
                  ? Effect.fail(new Error("Revocation has not arrived"))
                  : Effect.succeed(received);
              }),
              Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
            );
            expect(revocation).toEqual({
              token: "refresh",
              hint: "refresh_token",
              clientAuthenticated: true,
            });
            return exchanged.lastExchangeAuth;
          });

        // Notion accepts only Basic. Declared endpoints advertise no methods, so a client entered
        // with a secret uses Basic, which RFC 6749 requires every service to support.
        expect(yield* lifecycle(yield* declared("Basic-only service"), notionClient)).toBe(
          "client_secret_basic",
        );

        // HubSpot reads only the request body, so its declaration names that method.
        expect(
          yield* lifecycle(yield* declared("Body-only service", "client_secret_post"), {
            ...hubspotClient,
            methods: ["client_secret_post"],
          }),
        ).toBe("client_secret_post");

        // Google compares Basic credentials as sent: `-` and `.` must not be percent-encoded.
        yield* issuer.configure({ basicCredentials: "literal" });
        expect(
          yield* lifecycle(
            yield* declared("Literal Basic service", "client_secret_basic"),
            googleClient,
          ),
        ).toBe("client_secret_basic");

        // A discovered server can accept both forms while a client entered by hand was
        // registered for Basic only (RFC 8414 section 2, RFC 7591 section 2), so it keeps Basic.
        const discovered = { discover: `${issuer.origin}/mcp` };
        yield* issuer.configure({ authMethods: ["client_secret_basic", "client_secret_post"] });
        expect(
          yield* lifecycle(yield* deploy("Entered Basic client", discovered), notionClient),
        ).toBe("client_secret_basic");

        // PlanetScale's Doorkeeper advertises both methods and compares Basic literally.
        // A client Executor registers requests the body form, which it then accepts.
        yield* issuer.configure({
          authMethods: ["client_secret_basic", "client_secret_post"],
          registeredClient: doorkeeperClient,
        });
        expect(yield* lifecycle(yield* deploy("Registered client", discovered))).toBe(
          "client_secret_post",
        );
        expect((yield* issuer.metrics).lastRegistration?.method).toBe("client_secret_post");

        // A server that advertises only Basic still matches when it compares literally.
        yield* issuer.configure({ authMethods: ["client_secret_basic"] });
        expect(yield* lifecycle(yield* deploy("Registered Basic client", discovered))).toBe(
          "client_secret_basic",
        );
        expect((yield* issuer.metrics).lastRegistration?.method).toBe("client_secret_basic");
      }),
    ),
  );
});
