/**
 * Providers that declare OAuth endpoints directly, shaped like Google's authorization server, and
 * discovered servers that likewise leave client authentication to the client. Accounts started
 * without a name take the owner's first free default name for the provider when they complete.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile, Profile } from "../support/profiles.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const AppProvider = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const Failure = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
const Read = Schema.Struct({ refreshed: Schema.Boolean });
const SavedAccount = Schema.Struct({ id: Schema.String, label: Schema.String });
const clients = {
  confidential: { clientId: "confidential-client", clientSecret: "synthetic-manual-secret" },
  public: { clientId: "public-client" },
};

layer(HostedLive, { excludeTestServices: true })("OAuth declared endpoints", (it) => {
  it.effect(scenarios.oauthDeclaredEndpoints.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // Google signs users in on one host and exchanges tokens on another, then names the
        // sign-in host as `iss` in the callback and in the ID tokens `openid` returns. The fixture
        // serves both; `localhost` stands in for the sign-in host.
        const signInOrigin = issuer.origin.replace("127.0.0.1", "localhost");
        expect(new URL(signInOrigin).origin).not.toBe(new URL(issuer.origin).origin);
        const endpoints = {
          authorizationUrl: `${signInOrigin}/authorize`,
          tokenUrl: `${issuer.origin}/token`,
          scopes: ["openid", "read"],
        };
        const deploy = (name: string, config: object) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service=defineProvider({name:${JSON.stringify(name)},auth:{oauth:oauth2(${JSON.stringify(config)})}});
export default defineApp({accounts:{service}},async({accounts})=>({tools: router({
  read:query({input:object({})},async({fetch})=>{const result=await fetch(${JSON.stringify(`${issuer.origin}/resource`)},{headers:{authorization:"Bearer "+accounts.service.fields.access_token}});return result.json();}),
})}));`,
                },
                appsManifest,
              ],
            });
            expect(response.status).toBe(200);
            const app = yield* body(AppProvider, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const connect = (app: typeof AppProvider.Type) =>
          Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            return { app, profile, connection: connection.id };
          });
        const start = (
          connection: string,
          client: { readonly clientId: string; readonly clientSecret?: string },
          /** `null` starts sign-in without a name. */
          label: string | null = `Declared ${client.clientId}`,
        ) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection}/oauth/start`,
              { method: "oauth", ...(label === null ? {} : { label }), client },
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Redirect, response);
          });
        const consent = (authorizationUrl: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* HttpClient.withScope(http).get(authorizationUrl);
              expect(response.status).toBe(302);
              const location = response.headers.location;
              if (location === undefined)
                return yield* Effect.die("Issuer did not return a callback");
              return location;
            }),
          ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const complete = (connection: string, callbackUrl: string) =>
          api.request(actors.owner, "POST", `${prefix}/connections/${connection}/oauth/complete`, {
            callbackUrl,
          });
        const expectCompleted = (
          attempt: { readonly profile: typeof Profile.Type; readonly connection: string },
          response: { readonly status: number; readonly body: unknown },
          app: typeof AppProvider.Type,
        ) =>
          Effect.gen(function* () {
            expect(
              response.status,
              `${JSON.stringify(response.body)}, checks=${JSON.stringify((yield* issuer.metrics).tokenChecks)}`,
            ).toBe(200);
            const account = yield* body(SavedAccount, response);
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
                .pipe(Effect.orDie),
            );
            expect(
              (yield* api.request(
                actors.owner,
                "GET",
                `${prefix}/apps/${app.id}/profiles/${attempt.profile.id}`,
              )).body,
            ).toMatchObject({ accounts: { service: account.id } });
            expect(
              (yield* api.request(
                actors.owner,
                "GET",
                `${prefix}/connections/${attempt.connection}`,
              )).body,
            ).toMatchObject({ state: { status: "completed", account: { id: account.id } } });
            return account;
          });
        // Tokens are issued inside the host's renewal window, so using the account refreshes it.
        const expectRenewed = (
          attempt: { readonly profile: typeof Profile.Type },
          app: typeof AppProvider.Type,
        ) =>
          Effect.gen(function* () {
            const before = (yield* issuer.metrics).refreshes;
            const read = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/apps/${app.id}/tools/call`,
              { profile: attempt.profile.id, tool: "read", kind: "query", input: {} },
            );
            const metrics = yield* issuer.metrics;
            expect(
              read.status,
              `${JSON.stringify(read.body)}, checks=${JSON.stringify(metrics.refreshChecks)}`,
            ).toBe(200);
            expect(yield* body(Read, read)).toEqual({ refreshed: true });
            expect(metrics.refreshes).toBeGreaterThan(before);
          });

        // Undeclared issuer and client authentication, like the generated Google catalog apps.
        const undeclared = yield* deploy("Declared endpoints", endpoints);
        const setup = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/providers/${undeclared.requirements.accounts.service.provider}/oauth/oauth/setup`,
        );
        expect(setup.status).toBe(200);
        expect(setup.body).toEqual({
          mode: "client-required",
          scopes: ["openid", "read"],
          grant: "authorization_code",
        });
        // Executor never reads ID tokens, so sign-in and refresh succeed even though these name
        // the sign-in host rather than the derived issuer.
        yield* issuer.configure({
          callbackIssuer: signInOrigin,
          includeIdToken: true,
          idTokenIssuer: signInOrigin,
          idTokenAlgorithm: "RS256",
          refreshTokens: true,
          expiresIn: 20,
        });

        // Neither sign-in names its account, so each takes the owner's next default name.
        const confidential = yield* connect(undeclared);
        const confidentialStart = yield* start(confidential.connection, clients.confidential, null);
        yield* issuer.allowClient({
          ...clients.confidential,
          redirect: confidentialStart.redirectUri,
        });
        yield* issuer.allowClient({ ...clients.public, redirect: confidentialStart.redirectUri });
        const confidentialCallback = new URL(yield* consent(confidentialStart.authorizationUrl));
        expect(confidentialCallback.searchParams.get("iss")).toBe(signInOrigin);
        const confidentialAccount = yield* expectCompleted(
          confidential,
          yield* complete(confidential.connection, confidentialCallback.href),
          undeclared,
        );
        expect(confidentialAccount.label).toBe("Default");
        expect((yield* issuer.metrics).nonceRequested).toBe(false);
        expect((yield* issuer.metrics).lastExchangeAuth).toBe("client_secret_basic");
        yield* expectRenewed(confidential, undeclared);

        const publicClient = yield* connect(undeclared);
        const publicStart = yield* start(publicClient.connection, clients.public, null);
        const publicAccount = yield* expectCompleted(
          publicClient,
          yield* complete(publicClient.connection, yield* consent(publicStart.authorizationUrl)),
          undeclared,
        );
        expect((yield* issuer.metrics).lastExchangeAuth).toBe("none");
        expect(publicAccount.label).toBe("Default 2");
        // A reconnect keeps the account's current name instead of taking another default.
        const renamed = yield* api.request(
          actors.owner,
          "PATCH",
          `${prefix}/accounts/${publicAccount.id}`,
          { label: "Renamed public account" },
        );
        expect(renamed.status).toBe(200);
        const reconnection = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${publicClient.app.id}/connections`,
            {
              requirement: "service",
              profile: publicClient.profile.id,
              account: publicAccount.id,
            },
          ),
        );
        const reconnectStart = yield* start(reconnection.id, clients.public, null);
        const reconnected = yield* complete(
          reconnection.id,
          yield* consent(reconnectStart.authorizationUrl),
        );
        expect(reconnected.status, JSON.stringify(reconnected.body)).toBe(200);
        expect(yield* body(SavedAccount, reconnected)).toEqual({
          id: publicAccount.id,
          label: "Renamed public account",
        });

        // A declared issuer is the service's identifier, so the callback's `iss` must match it.
        const declared = yield* deploy("Declared issuer", { ...endpoints, issuer: signInOrigin });
        const matching = yield* connect(declared);
        const matchingStart = yield* start(matching.connection, clients.confidential);
        // A name supplied when sign-in starts is used as given.
        expect(
          (yield* expectCompleted(
            matching,
            yield* complete(matching.connection, yield* consent(matchingStart.authorizationUrl)),
            declared,
          )).label,
        ).toBe("Declared confidential-client");
        yield* expectRenewed(matching, declared);
        const expectRejected = (
          attempt: { readonly profile: typeof Profile.Type; readonly connection: string },
          response: { readonly status: number; readonly body: unknown },
          reason: "issuer_mismatch",
        ) =>
          Effect.gen(function* () {
            expect(response.status).toBe(400);
            expect(yield* body(Failure, response)).toEqual({
              _tag: "OAuthCompletionFailed",
              reason,
            });
            expect(
              (yield* body(
                Profile,
                yield* api.request(
                  actors.owner,
                  "GET",
                  `${prefix}/apps/${declared.id}/profiles/${attempt.profile.id}`,
                ),
              )).accounts,
            ).toEqual(attempt.profile.accounts);
            expect(
              (yield* api.request(
                actors.owner,
                "GET",
                `${prefix}/connections/${attempt.connection}`,
              )).body,
            ).toMatchObject({ state: { status: "pending" } });
          });
        // ID tokens are ignored, so one naming another issuer than the declared one never fails.
        yield* issuer.configure({ idTokenIssuer: issuer.origin });
        const foreignIdToken = yield* connect(declared);
        const foreignStart = yield* start(foreignIdToken.connection, clients.confidential);
        yield* expectCompleted(
          foreignIdToken,
          yield* complete(foreignIdToken.connection, yield* consent(foreignStart.authorizationUrl)),
          declared,
        );
        yield* expectRenewed(foreignIdToken, declared);
        yield* issuer.configure({ idTokenIssuer: signInOrigin });
        yield* issuer.configure({ callbackIssuer: issuer.origin });
        const mismatched = yield* connect(declared);
        const mismatchedStart = yield* start(mismatched.connection, clients.confidential);
        const mismatchedCallback = new URL(yield* consent(mismatchedStart.authorizationUrl));
        expect(mismatchedCallback.searchParams.get("iss")).toBe(issuer.origin);
        const exchanges = (yield* issuer.metrics).tokenExchanges;
        yield* expectRejected(
          mismatched,
          yield* complete(mismatched.connection, mismatchedCallback.href),
          "issuer_mismatch",
        );
        expect((yield* issuer.metrics).tokenExchanges).toBe(exchanges);

        // The client form offers an optional secret when the provider leaves authentication open.
        yield* issuer.configure({
          callbackIssuer: signInOrigin,
          browserReturn: (yield* Target).metadata.origin,
        });
        const formApp = yield* deploy("Open client auth", endpoints);
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the app with undeclared client authentication", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${formApp.id}?view=accounts`),
        );
        yield* browser.use("Open the account form", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        yield* browser.use("The client secret is offered as optional", (page) => {
          const dialog = page.getByRole("dialog");
          return dialog
            .getByLabel("Client secret (optional)", { exact: true })
            .waitFor({ state: "visible" })
            .then(() =>
              dialog
                .getByText("then enter its client ID (and secret, if it has one).", {
                  exact: false,
                })
                .count(),
            )
            .then((instructions) =>
              dialog
                .getByLabel("Client secret", { exact: true })
                .count()
                .then((required) => {
                  expect({ instructions, required }).toEqual({ instructions: 1, required: 0 });
                }),
            );
        });
        yield* browser.checkpoint("Optional client secret for undeclared client authentication");
        const exchangesBeforeForm = (yield* issuer.metrics).tokenExchanges;
        yield* browser.use("Connect a public client without a secret", (page) => {
          const dialog = page.getByRole("dialog");
          return dialog
            .getByLabel("Client ID", { exact: true })
            .fill(clients.public.clientId)
            .then(() =>
              dialog.getByRole("button", { name: "Connect Open client auth", exact: true }).click(),
            )
            .then(() => nameConnectedAccount(page, "Public form account"))
            .then(() =>
              page
                .getByRole("radio", { name: "Public form account", exact: true, checked: true })
                .waitFor({ state: "visible" }),
            );
        });
        expect((yield* issuer.metrics).tokenExchanges).toBe(exchangesBeforeForm + 1);
        expect((yield* issuer.metrics).lastExchangeAuth).toBe("none");
        const profile = yield* Schema.decodeUnknownEffect(Schema.String)(
          yield* browser.use("Read the selected account setup", (page) =>
            page.evaluate(() => new URL(location.href).searchParams.get("profile")),
          ),
        );
        const saved = yield* body(
          Schema.Struct({ accounts: Schema.Struct({ service: Schema.String }) }),
          yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${formApp.id}/profiles/${profile}`,
          ),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${saved.accounts.service}`)
            .pipe(Effect.orDie),
        );
        yield* browser.checkpoint("Public client connected from the form");

        // A discovered server that accepts public and secret clients (RFC 8414) and offers no
        // registration also leaves client authentication to each client.
        yield* issuer.configure({
          registration: false,
          authMethods: ["none", "client_secret_basic"],
          callbackIssuer: null,
          browserReturn: null,
          includeIdToken: false,
        });
        const discovered = yield* deploy("Discovered client auth", {
          discover: `${issuer.origin}/mcp`,
        });
        const discoveredSetup = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/providers/${discovered.requirements.accounts.service.provider}/oauth/oauth/setup`,
        );
        expect(discoveredSetup.status).toBe(200);
        expect(discoveredSetup.body).toEqual({
          mode: "client-required",
          scopes: ["read"],
          grant: "authorization_code",
        });
        const signInWith = (
          client: { readonly clientId: string; readonly clientSecret?: string },
          methods?: readonly ("client_secret_basic" | "client_secret_post")[],
        ) =>
          Effect.gen(function* () {
            const attempt = yield* connect(discovered);
            const started = yield* start(attempt.connection, client);
            yield* issuer.allowClient({
              ...client,
              redirect: started.redirectUri,
              ...(methods === undefined ? {} : { methods }),
            });
            yield* expectCompleted(
              attempt,
              yield* complete(attempt.connection, yield* consent(started.authorizationUrl)),
              discovered,
            );
            return (yield* issuer.metrics).lastExchangeAuth;
          });
        expect(yield* signInWith(clients.confidential)).toBe("client_secret_basic");
        expect(yield* signInWith(clients.public)).toBe("none");
        // A secret uses the body form when the server accepts only that one.
        yield* issuer.configure({ authMethods: ["none", "client_secret_post"] });
        expect(yield* signInWith(clients.confidential, ["client_secret_post"])).toBe(
          "client_secret_post",
        );
        // A server can accept both forms while this client was registered for Basic only
        // (RFC 8414 section 2, RFC 7591 section 2), so an entered secret keeps Basic.
        yield* issuer.configure({
          authMethods: ["none", "client_secret_basic", "client_secret_post"],
        });
        expect(yield* signInWith(clients.confidential, ["client_secret_basic"])).toBe(
          "client_secret_basic",
        );
      }),
    ),
  );
});
