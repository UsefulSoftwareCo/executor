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
import { linkedAccountIds, connectionsPath } from "../support/app-accounts.ts";
import { linkedChoice } from "../support/account-choices.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { enterClientDetails } from "../support/oauth-client-entry.ts";

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
export default defineApp({user: { accounts:{service} }},async({user: { accounts }})=>({tools: router({
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
            // The app's links before this connection completes.
            const linked = yield* linkedAccountIds(actors.owner, `${prefix}/apps/${app.id}`);
            const connection = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
                {},
              ),
            );
            return { app, linked, connection: connection.id };
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
          attempt: { readonly linked: ReadonlyArray<string>; readonly connection: string },
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
            // Completing links the new account to the app in place of its earlier link, as the
            // app's one requirement is plain; the earlier accounts stay saved.
            expect(yield* linkedAccountIds(actors.owner, `${prefix}/apps/${app.id}`)).toEqual([
              account.id,
            ]);
            for (const earlier of attempt.linked)
              expect(
                (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${earlier}`)).status,
              ).toBe(200);
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
        // Calls use the app's linked account.
        const expectRenewed = (account: string, app: typeof AppProvider.Type) =>
          Effect.gen(function* () {
            expect(yield* linkedAccountIds(actors.owner, `${prefix}/apps/${app.id}`)).toEqual([
              account,
            ]);
            const before = (yield* issuer.metrics).refreshes;
            const read = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/apps/${app.id}/tools/call`,
              { tool: "read", kind: "query", input: {} },
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
        // Endpoints without an issuer sign in at the server their token endpoint names.
        expect(setup.body).toEqual({
          mode: "client-required",
          scopes: ["openid", "read"],
          grant: "authorization_code",
          issuer: `${issuer.origin}/token`,
          resource: { value: null, source: "none" },
          clients: [],
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
        yield* expectRenewed(confidentialAccount.id, undeclared);

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
            connectionsPath(`${prefix}/apps/${publicClient.app.id}`, "user", "service"),
            {
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
        const matchingAccount = yield* expectCompleted(
          matching,
          yield* complete(matching.connection, yield* consent(matchingStart.authorizationUrl)),
          declared,
        );
        expect(matchingAccount.label).toBe("Declared confidential-client");
        yield* expectRenewed(matchingAccount.id, declared);
        const expectRejected = (
          attempt: { readonly linked: ReadonlyArray<string>; readonly connection: string },
          response: { readonly status: number; readonly body: unknown },
          reason: "issuer_mismatch",
        ) =>
          Effect.gen(function* () {
            expect(response.status).toBe(400);
            expect(yield* body(Failure, response)).toEqual({
              _tag: "OAuthCompletionFailed",
              reason,
            });
            // A rejected completion links nothing.
            expect(yield* linkedAccountIds(actors.owner, `${prefix}/apps/${declared.id}`)).toEqual(
              attempt.linked,
            );
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
        const foreignIdTokenAccount = yield* expectCompleted(
          foreignIdToken,
          yield* complete(foreignIdToken.connection, yield* consent(foreignStart.authorizationUrl)),
          declared,
        );
        yield* expectRenewed(foreignIdTokenAccount.id, declared);
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
          page
            .getByRole("button", { name: "Connect new account", exact: true })
            .click()
            .then(() => enterClientDetails(page)),
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
              linkedChoice(page, "Open client auth", "Public form account").waitFor({
                state: "visible",
              }),
            );
        });
        expect((yield* issuer.metrics).tokenExchanges).toBe(exchangesBeforeForm + 1);
        expect((yield* issuer.metrics).lastExchangeAuth).toBe("none");
        // Connecting from the app's form linked the new account to it.
        const [saved, ...extra] = yield* linkedAccountIds(
          actors.owner,
          `${prefix}/apps/${formApp.id}`,
        );
        if (saved === undefined) return yield* Effect.die("The form's account is not linked");
        expect(extra).toEqual([]);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/accounts/${saved}`).pipe(Effect.orDie),
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
          issuer: issuer.origin,
          resource: { value: `${issuer.origin}/mcp`, source: "metadata" },
          clients: [],
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
