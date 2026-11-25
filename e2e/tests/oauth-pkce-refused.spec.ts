import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";

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
const Setup = Schema.Struct({ issuer: Schema.String });
const Registered = Schema.Struct({
  client: Schema.Struct({ id: Schema.String }),
  access: Schema.Struct({ revision: Schema.String }),
});
const BuildFailed = Schema.Struct({ stage: Schema.String, message: Schema.String });
const CompletionFailure = Schema.Struct({ _tag: Schema.String, reason: Schema.String });
const Presented = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  recovery: Schema.Struct({ action: Schema.String }),
});
const Redeployed = Schema.Struct({ app: AppProvider });

const secrets = {
  reserved: "Ab+c/d=e%f&g:h",
  encoded: "x%2By%20z",
  inner: "inner space",
  unicode: "sécrét-✓",
  linkedinShaped: "WPL_AP1.syntheticSecret.Ab12==",
};

type Method = "client_secret_post" | "client_secret_basic";
type Credentials = { readonly clientId: string; readonly clientSecret: string };

const harness = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    http = yield* HttpClient.HttpClient;
  const issuer = yield* oauthSetupIssuer;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const source = (name: string, config: object) =>
    `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service=defineProvider({name:${JSON.stringify(name)},auth:{oauth:oauth2(${JSON.stringify(config)})}});
export default defineApp({user: { accounts:{service} }},async()=>({tools: router({
  read:query({input:object({})},async()=>({ok:true})),
})}));`;
  const redeploy = (app: string, name: string, config: object) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/${app}/deploy`, {
        files: [{ path: "index.ts", content: source(name, config) }, appsManifest],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (yield* body(Redeployed, response)).app;
    });
  const deployRequest = (name: string, config: object) =>
    api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content: source(name, config) }, appsManifest],
    });
  const deploy = (name: string, config: object) =>
    Effect.gen(function* () {
      const response = yield* deployRequest(name, config);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const app = yield* body(AppProvider, response);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      return app;
    });
  const endpoints = {
    authorizationUrl: `${issuer.origin}/authorize`,
    tokenUrl: `${issuer.origin}/token`,
    scopes: ["openid", "profile"],
  };
  const connectionRequest = (app: string, account?: string) =>
    api.request(
      actors.owner,
      "POST",
      connectionsPath(`${prefix}/apps/${app}`, "user", "service"),
      account === undefined ? {} : { account },
    );
  const connection = (app: string, account?: string) =>
    connectionRequest(app, account).pipe(
      Effect.flatMap((response) => body(Resource, response)),
      Effect.map((resource) => resource.id),
    );
  const start = (id: string, client: object) =>
    Effect.gen(function* () {
      const response = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${id}/oauth/start`,
        { method: "oauth", label: `PKCE ${randomUUID().slice(0, 6)}`, client },
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
        if (location === undefined) return yield* Effect.die("Issuer did not return a callback");
        return location;
      }),
    ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  const complete = (id: string, callbackUrl: string) =>
    api.request(actors.owner, "POST", `${prefix}/connections/${id}/oauth/complete`, {
      callbackUrl,
    });
  const signIn = (
    app: typeof AppProvider.Type,
    credentials: Credentials,
    method: Method,
    client: object,
    account?: string,
  ) =>
    Effect.gen(function* () {
      const id = yield* connection(app.id, account);
      const started = yield* start(id, client);
      yield* issuer.allowClient({
        ...credentials,
        redirect: started.redirectUri,
        methods: [method],
      });
      const query = new URL(started.authorizationUrl).searchParams;
      const response = yield* complete(id, yield* consent(started.authorizationUrl));
      const completed = response.status === 200 ? yield* body(Resource, response) : undefined;
      if (completed !== undefined && account === undefined)
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${completed.id}`)
            .pipe(Effect.orDie),
        );
      return {
        response,
        account: completed?.id,
        challenge: query.get("code_challenge"),
        challengeMethod: query.get("code_challenge_method"),
        metrics: yield* issuer.metrics,
      };
    });
  return {
    api,
    actors,
    prefix,
    issuer,
    deploy,
    redeploy,
    deployRequest,
    endpoints,
    signIn,
    connection,
    connectionRequest,
    start,
    consent,
    complete,
  };
});

layer(HostedLive, { excludeTestServices: true })("OAuth PKCE refused", (it) => {
  it.effect(scenarios.oauthPkceRefused.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, issuer, deploy, deployRequest, endpoints, signIn } =
          yield* harness;
        yield* issuer.configure({ pkce: "refused" });

        const undeclared = yield* deploy("PKCE sent", {
          ...endpoints,
          tokenEndpointAuthMethod: "client_secret_post",
        });
        const refusedBefore = (yield* issuer.metrics).refusedClientAuthentications;
        const undeclaredClient = {
          clientId: `undeclared-${randomUUID()}`,
          clientSecret: secrets.linkedinShaped,
        };
        const refused = yield* signIn(
          undeclared,
          undeclaredClient,
          "client_secret_post",
          undeclaredClient,
        );
        expect(refused.challenge).not.toBeNull();
        expect(refused.response.status, JSON.stringify(refused.response.body)).toBe(400);
        expect(yield* body(CompletionFailure, refused.response)).toMatchObject({
          _tag: "OAuthCompletionFailed",
          reason: "invalid_client",
        });
        expect(refused.metrics.refusedClientAuthentications).toBe(refusedBefore + 1);

        for (const method of ["client_secret_post", "client_secret_basic"] as const) {
          const app = yield* deploy(`PKCE refused ${method}`, {
            ...endpoints,
            tokenEndpointAuthMethod: method,
            pkce: false,
          });
          const setup = yield* body(
            Setup,
            yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
            ),
          );
          const expectNoPkce = (
            signedIn: Effect.Success<ReturnType<typeof signIn>>,
            label: string,
          ) => {
            expect(
              signedIn.response.status,
              `${label}: ${JSON.stringify(signedIn.response.body)} checks=${JSON.stringify(signedIn.metrics.tokenChecks)}`,
            ).toBe(200);
            expect(signedIn.challenge, label).toBeNull();
            expect(signedIn.challengeMethod, label).toBeNull();
            expect(signedIn.metrics.authorizationChallenged, label).toBe(false);
            expect(signedIn.metrics.lastExchangeAuth, label).toBe(method);
            expect(signedIn.metrics.tokenChecks, label).toMatchObject({
              pkce: true,
              authClient: true,
              authSecret: true,
            });
          };
          let last: { credentials: Credentials; client: object; account: string } | undefined;
          for (const [name, clientSecret] of Object.entries(secrets))
            for (const saved of ["entered", "registered", "updated"] as const) {
              const credentials = {
                clientId: `${saved}-${name}-${randomUUID().slice(0, 8)}:a+b`,
                clientSecret,
              };
              let client: object = credentials;
              if (saved !== "entered") {
                const registered = yield* body(
                  Registered,
                  yield* api.request(actors.owner, "POST", `${prefix}/oauth-clients`, {
                    issuer: setup.issuer,
                    clientId: credentials.clientId,
                    clientSecret: saved === "updated" ? "synthetic-replaced-secret" : clientSecret,
                  }),
                );
                yield* Effect.addFinalizer(() =>
                  api
                    .request(
                      actors.owner,
                      "DELETE",
                      `${prefix}/oauth-clients/${registered.client.id}`,
                    )
                    .pipe(Effect.orDie),
                );
                if (saved === "updated") {
                  const updated = yield* api.request(
                    actors.owner,
                    "PATCH",
                    `${prefix}/oauth-clients/${registered.client.id}`,
                    { clientSecret, revision: registered.access.revision },
                  );
                  expect(updated.status, JSON.stringify(updated.body)).toBe(200);
                }
                client = { id: registered.client.id };
              }
              const signedIn = yield* signIn(app, credentials, method, client);
              expectNoPkce(signedIn, `${method} ${saved} ${name}`);
              if (signedIn.account !== undefined)
                last = { credentials, client, account: signedIn.account };
            }
          if (last === undefined) return yield* Effect.die("No account signed in");
          const reconnected = yield* signIn(
            app,
            last.credentials,
            method,
            last.client,
            last.account,
          );
          expectNoPkce(reconnected, `${method} reconnect`);
          expect(reconnected.account).toBe(last.account);
        }
        for (const tokenEndpointAuthMethod of [undefined, "none"]) {
          const publicClient = yield* deployRequest("PKCE refused public", {
            ...endpoints,
            ...(tokenEndpointAuthMethod === undefined ? {} : { tokenEndpointAuthMethod }),
            pkce: false,
          });
          expect(publicClient.status, JSON.stringify(publicClient.body)).toBe(422);
          const failure = yield* body(BuildFailed, publicClient);
          expect(failure.stage).toBe("declaration");
          expect(failure.message).toContain(
            "DeclarationInvalid: The oauth2() declaration is invalid. pkce: pkce: false requires tokenEndpointAuthMethod client_secret_post, client_secret_basic or client_secret_basic_raw.",
          );
        }

        expect((yield* issuer.metrics).refusedClientAuthentications).toBe(refusedBefore + 1);
      }),
    ),
  );

  it.effect(scenarios.oauthPkceDefault.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { issuer, deploy, endpoints, signIn } = yield* harness;
        yield* issuer.configure({ pkce: "required" });
        const app = yield* deploy("PKCE default", {
          ...endpoints,
          tokenEndpointAuthMethod: "client_secret_post",
        });
        const credentials = {
          clientId: `default-${randomUUID()}`,
          clientSecret: secrets.linkedinShaped,
        };
        const expectPkce = (signedIn: Effect.Success<ReturnType<typeof signIn>>, label: string) => {
          expect(
            signedIn.response.status,
            `${label}: ${JSON.stringify(signedIn.response.body)} checks=${JSON.stringify(signedIn.metrics.tokenChecks)}`,
          ).toBe(200);
          expect(signedIn.challenge, label).toMatch(/^[\w-]{43}$/);
          expect(signedIn.challengeMethod, label).toBe("S256");
          expect(signedIn.metrics.authorizationChallenged, label).toBe(true);
          expect(signedIn.metrics.tokenChecks, label).toMatchObject({ pkce: true });
        };
        const signedIn = yield* signIn(app, credentials, "client_secret_post", credentials);
        expectPkce(signedIn, "sign-in");
        if (signedIn.account === undefined) return yield* Effect.die("No account signed in");
        const reconnected = yield* signIn(
          app,
          credentials,
          "client_secret_post",
          credentials,
          signedIn.account,
        );
        expectPkce(reconnected, "reconnect");
        expect(reconnected.account).toBe(signedIn.account);
      }),
    ),
  );
  it.effect(scenarios.oauthPkceChanged.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          prefix,
          issuer,
          deploy,
          redeploy,
          endpoints,
          signIn,
          connection,
          connectionRequest,
          start,
          consent,
          complete,
        } = yield* harness;
        yield* issuer.configure({ pkce: "required" });
        const declared = { ...endpoints, tokenEndpointAuthMethod: "client_secret_post" };
        const app = yield* deploy("PKCE changed", declared);
        const credentials = {
          clientId: `changed-${randomUUID()}`,
          clientSecret: secrets.linkedinShaped,
        };
        const signedIn = yield* signIn(app, credentials, "client_secret_post", credentials);
        expect(signedIn.response.status, JSON.stringify(signedIn.response.body)).toBe(200);
        expect(signedIn.challenge).not.toBeNull();
        if (signedIn.account === undefined) return yield* Effect.die("No account signed in");

        const pending = yield* connection(app.id);
        const started = yield* start(pending, credentials);
        expect(new URL(started.authorizationUrl).searchParams.get("code_challenge")).not.toBeNull();
        const callbackUrl = yield* consent(started.authorizationUrl);

        const changed = yield* redeploy(app.id, "PKCE changed", { ...declared, pkce: false });
        expect(changed.requirements.accounts.service.provider).not.toBe(
          app.requirements.accounts.service.provider,
        );

        const completed = yield* complete(pending, callbackUrl);
        expect(completed.status, JSON.stringify(completed.body)).toBe(409);
        expect(yield* body(Presented, completed)).toEqual({
          _tag: "AccountConnectionTargetChanged",
          message: "This connection no longer matches the app’s requirements.",
          recovery: { action: "Close this form and start account setup again." },
        });

        const reconnect = yield* connectionRequest(app.id, signedIn.account);
        expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(422);
        expect(yield* body(CompletionFailure, reconnect)).toMatchObject({
          _tag: "AccountSelectionInvalid",
          reason: "provider_mismatch",
        });
        expect((yield* body(Presented, reconnect)).recovery.action).toBe(
          "Open Accounts and connect a new account for this requirement.",
        );
        const kept = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/accounts/${signedIn.account}`,
        );
        expect(kept.status, JSON.stringify(kept.body)).toBe(200);

        yield* issuer.configure({ pkce: "refused" });
        const fresh = yield* signIn(changed, credentials, "client_secret_post", credentials);
        expect(fresh.response.status, JSON.stringify(fresh.response.body)).toBe(200);
        expect(fresh.challenge).toBeNull();
        expect(fresh.account).not.toBe(signedIn.account);
      }),
    ),
  );
});
