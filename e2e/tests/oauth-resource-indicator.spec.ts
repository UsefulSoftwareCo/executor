/**
 * Executor sends one RFC 8707 resource indicator on a sign-in's authorization request, its code
 * exchange and every renewal: the provider's declared `resource`, the one the service's
 * protected-resource metadata names, or the operator client's own. The setup check reports which
 * one and where it came from, or why none is sent. A refused indicator, or its absence, fails
 * sign-in naming that and sends recovery to whoever can change it; a declared one replaces it
 * everywhere. Only a refusal is: a 429 or an outage keeps its own failure.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { oauthInteropIssuer } from "../support/oauth-interop-issuer.ts";
import { serverControl } from "../support/server-control.ts";
import {
  resourceIndicatorIssuer,
  unknownResourceDescription,
} from "../support/resource-indicator-issuer.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
  }),
});
const Resource = Schema.Struct({ id: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Indicator = Schema.Struct({ value: Schema.NullOr(Schema.String), source: Schema.String });
const Setup = Schema.Struct({
  scopes: Schema.Array(Schema.String),
  resource: Indicator,
});
const Failure = Schema.Struct({
  _tag: Schema.String,
  reason: Schema.String,
  message: Schema.String,
  cause: Schema.optional(
    Schema.Struct({ stage: Schema.String, status: Schema.optional(Schema.Number) }),
  ),
  retryAfter: Schema.optional(Schema.String),
  recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
  resource: Schema.optional(Indicator),
  serviceError: Schema.optional(
    Schema.Struct({ error: Schema.String, description: Schema.optional(Schema.String) }),
  ),
});
const Health = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      check: Schema.NullOr(Schema.Struct({ status: Schema.String })),
    }),
  ),
});

/** The app's own settings can change what its sign-in sends. */
const appRecovery = "Set the resource the service documents in the app’s OAuth settings.";
/** The operator's client is the instance's, so its administrator can change what it sends. */
const administratorRecovery =
  "Ask the instance administrator to check the OAuth client’s resource.";

/**
 * The operator's OAuth client for the service, with its own resource or none. An E2E host adds it
 * to the reviewed clients from `EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS`.
 */
const operatorSettings = (origin: string, resource: string | undefined) => ({
  EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([
    {
      id: "synthetic-mail",
      label: "Executor for the resource service",
      server: {
        issuer: origin,
        authorizationUrl: `${origin}/authorize`,
        tokenUrl: `${origin}/token`,
        ...(resource === undefined ? {} : { resource }),
      },
      tokenEndpointAuthMethod: "client_secret_basic",
      defaultScopes: ["read"],
      allowedScopes: ["read"],
      placement: { hosts: [new URL(origin).host] },
    },
  ]),
  EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID: "first-party-client",
  EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET: "first-party-secret",
});
const noOperatorClients = {
  EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: "",
  EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID: "",
  EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET: "",
};
/** Restart the product with the operator's client settings changed to `settings`. */
const restartWith = (settings: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    yield* serverControl("stop");
    yield* serverControl("environment", 200, settings);
    yield* serverControl("start");
  });

/** An app whose one OAuth account reads the service's API, and whose check does the same read. */
const source = (
  config: object,
  api: string,
) => `import { ProviderError, defineApp, defineProvider, oauth2, object, query, router } from "apps";
const api = ${JSON.stringify(api)};
const headers = (account) => ({ authorization: "Bearer " + account.fields.access_token });
const service = defineProvider({
  name: "Resource service",
  auth: { oauth: oauth2(${JSON.stringify(config)}) },
  async health({ account, fetch, signal }) {
    const response = await fetch(api, { signal, headers: headers(account) });
    if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401 });
    return {};
  },
});
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
  tools: router({
    read: query({ input: object({}) }, async ({ fetch }) => {
      const response = await fetch(api, { headers: headers(accounts.service) });
      return { status: response.status };
    }),
  }),
}));
`;

const resourceApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    http = yield* HttpClient.HttpClient;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deploy = (config: object, apiUrl: string) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `Resource indicator ${randomUUID().slice(0, 8)}`,
        files: [{ path: "index.ts", content: source(config, apiUrl) }, appsManifest],
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(App, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      const provider = app.requirements.accounts["service"]?.provider;
      if (provider === undefined) return yield* Effect.die("The app declares no account");
      return { app: app.id, provider };
    });
  /** What account setup reports it will send, before any sign-in. */
  const setup = (provider: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(
        actors.owner,
        "GET",
        `${prefix}/providers/${provider}/oauth/oauth/setup`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(Setup, response);
    });
  /** Start a sign-in, consent at the service and complete it with the callback it returns. */
  const connect = (app: string) =>
    Effect.gen(function* () {
      const connection = yield* body(
        Resource,
        yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(`${prefix}/apps/${app}`, "user", "service"),
          {},
        ),
      );
      const started = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection.id}/oauth/start`,
        { method: "oauth", label: "Resource account" },
      );
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const authorizationUrl = new URL((yield* body(SignIn, started)).authorizationUrl);
      const callbackUrl = yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* HttpClient.withScope(http).get(authorizationUrl.href);
          expect(response.status).toBe(302);
          const location = response.headers.location;
          if (location === undefined) return yield* Effect.die("Service did not return a callback");
          return location;
        }),
      ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      const completed = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection.id}/oauth/complete`,
        { callbackUrl },
      );
      if (completed.status === 200) {
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
      }
      return { authorizationUrl, completed };
    });
  const check = (account: string, app: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/accounts/${account}/health`,
        { apps: [app] },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (yield* body(Health, response)).apps.find((entry) => entry.app === app)?.check;
    });
  const read = (app: string) =>
    api.request(actors.owner, "POST", `${prefix}/apps/${app}/tools/call`, {
      tool: "read",
      kind: "query",
      input: {},
    });
  return { deploy, setup, connect, check, read };
});

layer(HostedLive, { excludeTestServices: true })("OAuth resource indicators", (it) => {
  it.effect(scenarios.oauthResourceRefused.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* resourceApp;
        const service = yield* resourceIndicatorIssuer("refuses-unknown");

        // The service's metadata names its origin, so setup reports that it will send it.
        const discovered = yield* app.deploy({ discover: service.origin }, service.apiResource);
        expect((yield* app.setup(discovered.provider)).resource).toEqual({
          value: service.origin,
          source: "metadata",
        });

        // Its token endpoint does not know that resource. The failure names what was sent, where
        // it came from, and that declaring the same value would send the same request.
        const refused = yield* app.connect(discovered.app);
        expect(refused.authorizationUrl.searchParams.get("resource")).toBe(service.origin);
        expect(refused.completed.status, JSON.stringify(refused.completed.body)).toBe(400);
        const failure = yield* body(Failure, refused.completed);
        expect(failure).toMatchObject({
          _tag: "OAuthCompletionFailed",
          reason: "resource_rejected",
          resource: { value: service.origin, source: "metadata" },
          serviceError: { error: "invalid_target", description: unknownResourceDescription },
        });
        expect(failure.message).toContain("resource");
        expect(failure.recovery.instructions).toContain(service.origin);
        expect(failure.recovery.instructions).toContain("protected-resource metadata");
        expect(failure.recovery.instructions).toContain("resource: null");
        // The previous copy pointed at the client and the callback instead.
        expect(failure.recovery.instructions).not.toContain("callback configuration");

        // A provider that declares the same value sends the same request, and is told so.
        const same = yield* app.deploy(
          { discover: service.origin, resource: service.origin },
          service.apiResource,
        );
        expect((yield* app.setup(same.provider)).resource).toEqual({
          value: service.origin,
          source: "declared",
        });
        const again = yield* body(Failure, (yield* app.connect(same.app)).completed);
        expect(again).toMatchObject({
          reason: "resource_rejected",
          resource: { value: service.origin, source: "declared" },
        });

        // Declaring the resource the service serves replaces the discovered one everywhere.
        const declared = yield* app.deploy(
          { discover: service.origin, resource: service.apiResource },
          service.apiResource,
        );
        const signIn = yield* app.connect(declared.app);
        expect(signIn.completed.status, JSON.stringify(signIn.completed.body)).toBe(200);
        expect(signIn.authorizationUrl.searchParams.get("resource")).toBe(service.apiResource);
        const read = yield* app.read(declared.app);
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        expect(read.body).toMatchObject({ status: 200 });
        expect((yield* service.metrics).tokenRequests).toEqual([
          { grant: "authorization_code", resource: service.origin, issued: false },
          { grant: "authorization_code", resource: service.origin, issued: false },
          { grant: "authorization_code", resource: service.apiResource, issued: true },
        ]);
      }),
    ),
  );

  it.effect(scenarios.oauthResourceAudience.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* resourceApp;
        const service = yield* resourceIndicatorIssuer("binds-audience");

        // Sign-in completes with the resource the metadata names, but the API refuses the token.
        const discovered = yield* app.deploy({ discover: service.origin }, service.apiResource);
        const signIn = yield* app.connect(discovered.app);
        expect(signIn.completed.status, JSON.stringify(signIn.completed.body)).toBe(200);
        const account = (yield* body(Resource, signIn.completed)).id;
        expect((yield* app.check(account, discovered.app))?.status).toBe("credentials_rejected");
        // The dashboard says the credentials don't work, not that sign-in was rejected: the
        // sign-in completed. The same status also covers a sign-in that expired before any
        // request, so the label does not say the service refused them.
        const actors = yield* Actors,
          browser = yield* Browser;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the account the service refused", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/accounts`)
            .then(() => page.getByRole("button", { name: "Manage Resource account" }).click())
            .then(() => page.getByRole("menuitem", { name: "Check health" }).click()),
        );
        expect(
          yield* browser.use("The check says the credentials don't work", (page) =>
            page
              .getByRole("dialog")
              .locator('[data-check-status="credentials_rejected"][data-check-current="true"]')
              .first()
              .innerText(),
          ),
        ).toBe("Credentials not working");
        yield* browser.checkpoint("Credentials not working after a completed sign-in");
        yield* browser.use("Close the account's health", (page) =>
          page.getByRole("button", { name: "Close", exact: true }).first().click(),
        );
        // The refusal renews the grant once, with the same resource, and the API refuses that too.
        const metrics = yield* service.metrics;
        expect(metrics.tokenRequests).toEqual([
          { grant: "authorization_code", resource: service.origin, issued: true },
          { grant: "refresh_token", resource: service.origin, issued: true },
        ]);
        expect(new Set(metrics.apiRequests.map((request) => request.audience))).toEqual(
          new Set([service.origin]),
        );
        // Setup reports the resource the token was issued for, which the agent can compare with
        // the API's own identifier.
        expect((yield* app.setup(discovered.provider)).resource).toEqual({
          value: service.origin,
          source: "metadata",
        });

        // With the API's resource declared, the token it issues is accepted.
        const declared = yield* app.deploy(
          { discover: service.origin, resource: service.apiResource },
          service.apiResource,
        );
        const fixed = yield* app.connect(declared.app);
        expect(fixed.completed.status, JSON.stringify(fixed.completed.body)).toBe(200);
        const fixedAccount = (yield* body(Resource, fixed.completed)).id;
        expect((yield* app.check(fixedAccount, declared.app))?.status).toBe("healthy");
      }),
    ),
  );
  it.effect(scenarios.oauthResourceOmitted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* resourceApp;

        // `resource: null` sends none although the service's metadata names one. Its refusal says
        // the provider declared none, not that nothing names one.
        const service = yield* resourceIndicatorIssuer("refuses-unknown");
        const declaredNone = yield* app.deploy(
          { discover: service.origin, resource: null },
          service.apiResource,
        );
        expect((yield* app.setup(declaredNone.provider)).resource).toEqual({
          value: null,
          source: "declared",
        });
        const refused = yield* app.connect(declaredNone.app);
        expect(refused.authorizationUrl.searchParams.has("resource")).toBe(false);
        expect(refused.completed.status, JSON.stringify(refused.completed.body)).toBe(400);
        const failure = yield* body(Failure, refused.completed);
        expect(failure).toMatchObject({
          _tag: "OAuthCompletionFailed",
          reason: "resource_rejected",
          cause: { stage: "exchange", status: 400 },
          resource: { value: null, source: "declared" },
          serviceError: { error: "invalid_target", description: unknownResourceDescription },
        });
        expect(failure.message).toContain("This sign-in sent none");
        expect(failure.recovery.action).toBe(appRecovery);
        expect(failure.recovery.instructions).toContain("declares `resource: null`");
        expect(failure.recovery.instructions).not.toContain("declares no `resource`");
        expect(failure.recovery.instructions).not.toContain(service.origin);
        expect((yield* service.metrics).tokenRequests).toEqual([
          { grant: "authorization_code", resource: null, issued: false },
        ]);

        // A service that publishes no protected-resource metadata, for a provider that declares
        // no resource: nothing names one.
        const unnamed = yield* resourceIndicatorIssuer("refuses-unknown", { metadata: false });
        const undeclared = yield* app.deploy({ discover: unnamed.origin }, unnamed.apiResource);
        expect((yield* app.setup(undeclared.provider)).resource).toEqual({
          value: null,
          source: "none",
        });
        const none = yield* body(Failure, (yield* app.connect(undeclared.app)).completed);
        expect(none).toMatchObject({
          reason: "resource_rejected",
          resource: { value: null, source: "none" },
        });
        expect(none.recovery.action).toBe(appRecovery);
        expect(none.recovery.instructions).toContain(
          "the provider declares no `resource`, and no protected-resource metadata it discovers from names one",
        );

        // Microsoft's authorization server takes the audience from the scopes, so the resource
        // its metadata names is not sent, and setup says that Executor inferred why.
        const entra = yield* oauthInteropIssuer("entra-tenant");
        const scoped = yield* app.deploy(
          { discover: `${entra.origin}/mcp` },
          `${entra.origin}/mcp`,
        );
        expect((yield* app.setup(scoped.provider)).resource).toEqual({
          value: null,
          source: "inferred_scope_audience",
        });

        // Any service can publish that metadata. One that still requires its resource refuses the
        // sign-in, which then reports the omission as Executor's inference, not the server's
        // behavior, and points at declaring the resource.
        const claims = yield* resourceIndicatorIssuer("refuses-unknown", {
          scopeAudienceClaim: true,
        });
        const inferred = yield* app.deploy({ discover: claims.origin }, claims.apiResource);
        expect((yield* app.setup(inferred.provider)).resource).toEqual({
          value: null,
          source: "inferred_scope_audience",
        });
        const withheld = yield* app.connect(inferred.app);
        expect(withheld.authorizationUrl.searchParams.has("resource")).toBe(false);
        expect(withheld.completed.status, JSON.stringify(withheld.completed.body)).toBe(400);
        const guessed = yield* body(Failure, withheld.completed);
        expect(guessed).toMatchObject({
          _tag: "OAuthCompletionFailed",
          reason: "resource_rejected",
          cause: { stage: "exchange", status: 400 },
          resource: { value: null, source: "inferred_scope_audience" },
          serviceError: { error: "invalid_target", description: unknownResourceDescription },
        });
        expect(guessed.message).toContain("This sign-in sent none");
        expect(guessed.recovery.action).toBe(appRecovery);
        expect(guessed.recovery.instructions).toContain("Executor inferred");
        expect(guessed.recovery.instructions).toContain("Executor did not verify this");
        expect(guessed.recovery.instructions).toContain(
          "declare the identifier the service documents as the provider's `resource`",
        );
        // The service's metadata is its own claim, so the copy does not state it as fact.
        expect(guessed.recovery.instructions).not.toContain("authorization server takes");
        // The declared resource is sent despite the metadata, and the service issues a token.
        const declaredApi = yield* app.deploy(
          { discover: claims.origin, resource: claims.apiResource },
          claims.apiResource,
        );
        expect((yield* app.setup(declaredApi.provider)).resource).toEqual({
          value: claims.apiResource,
          source: "declared",
        });
        const fixed = yield* app.connect(declaredApi.app);
        expect(fixed.completed.status, JSON.stringify(fixed.completed.body)).toBe(200);
        expect(fixed.authorizationUrl.searchParams.get("resource")).toBe(claims.apiResource);
        expect((yield* claims.metrics).tokenRequests).toEqual([
          { grant: "authorization_code", resource: null, issued: false },
          { grant: "authorization_code", resource: claims.apiResource, issued: true },
        ]);
      }),
    ),
  );

  it.effect(scenarios.oauthResourceOperator.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* resourceApp;
        const service = yield* resourceIndicatorIssuer("refuses-unknown");
        yield* service.addClient("first-party-client", "first-party-secret");
        // Whatever happens, the next scenario finds the product without the operator's client.
        yield* Effect.addFinalizer(() => restartWith(noOperatorClients).pipe(Effect.orDie));

        // The provider declares the resource the service accepts, but the operator's client, which
        // signs in for it, sends its own. Only the administrator can change that.
        for (const [operatorResource, expected] of [
          [service.origin, { value: service.origin, source: "operator" }],
          [undefined, { value: null, source: "operator" }],
        ] as const) {
          yield* restartWith(operatorSettings(service.origin, operatorResource));
          const declared = yield* app.deploy(
            { discover: service.origin, resource: service.apiResource },
            service.apiResource,
          );
          expect((yield* app.setup(declared.provider)).resource).toEqual(expected);
          const refused = yield* app.connect(declared.app);
          expect(refused.authorizationUrl.searchParams.get("resource")).toBe(expected.value);
          expect(refused.completed.status, JSON.stringify(refused.completed.body)).toBe(400);
          const failure = yield* body(Failure, refused.completed);
          expect(failure).toMatchObject({
            _tag: "OAuthCompletionFailed",
            reason: "resource_rejected",
            resource: expected,
          });
          expect(failure.recovery.action).toBe(administratorRecovery);
          expect(failure.recovery.instructions).toContain(
            "a provider's `resource` does not apply to that client, so changing the app does not change this request",
          );
          expect(failure.recovery.instructions).not.toContain(appRecovery);
          expect(failure.recovery.instructions).not.toContain("Declare the provider's `resource`");
        }
        expect((yield* service.metrics).tokenRequests).toEqual([
          { grant: "authorization_code", resource: service.origin, issued: false },
          { grant: "authorization_code", resource: null, issued: false },
        ]);
      }),
    ),
  );

  it.effect(scenarios.oauthResourceTransient.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* resourceApp;
        const service = yield* resourceIndicatorIssuer("refuses-unknown");
        const discovered = yield* app.deploy({ discover: service.origin }, service.apiResource);

        // A 429 is the service limiting requests, whatever its body says: the failure keeps the
        // time its Retry-After names and asks for no configuration change.
        yield* service.refuseWith({ status: 429, retryAfter: "120" });
        const limited = yield* app.connect(discovered.app);
        expect(limited.completed.status, JSON.stringify(limited.completed.body)).toBe(400);
        const rateLimited = yield* body(Failure, limited.completed);
        expect(rateLimited).toMatchObject({
          _tag: "OAuthCompletionFailed",
          reason: "rate_limited",
          cause: { stage: "exchange", status: 429 },
          serviceError: { error: "invalid_target" },
        });
        expect(rateLimited.retryAfter).toBeDefined();
        expect(rateLimited.resource).toBeUndefined();
        expect(rateLimited.recovery.instructions).toContain("Retry-After");

        // A 503 is an outage, not a refusal of the resource.
        yield* service.refuseWith({ status: 503 });
        const unavailable = yield* body(Failure, (yield* app.connect(discovered.app)).completed);
        expect(unavailable).toMatchObject({
          reason: "service_unavailable",
          cause: { stage: "exchange", status: 503 },
          serviceError: { error: "invalid_target" },
        });
        expect(unavailable.retryAfter).toBeUndefined();
        expect(unavailable.resource).toBeUndefined();

        // The same answer with a 400 is a refusal of the resource the sign-in sent.
        yield* service.refuseWith({ status: 400 });
        const refused = yield* body(Failure, (yield* app.connect(discovered.app)).completed);
        expect(refused).toMatchObject({
          reason: "resource_rejected",
          cause: { stage: "exchange", status: 400 },
          resource: { value: service.origin, source: "metadata" },
        });
        expect((yield* service.metrics).tokenRequests).toEqual([
          { grant: "authorization_code", resource: service.origin, issued: false },
          { grant: "authorization_code", resource: service.origin, issued: false },
          { grant: "authorization_code", resource: service.origin, issued: false },
        ]);
      }),
    ),
  );
});
