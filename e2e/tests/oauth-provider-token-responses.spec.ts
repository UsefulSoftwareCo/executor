/**
 * Sign in and renew against a loopback issuer that answers with the token responses real services
 * send: Slack's `bot` type, Shopify and Mailchimp without a type, null or array members, and
 * an empty scope. Declared options read Slack's nested user grant and send JSON token requests.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import type { TestContext } from "vitest";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer, type TokenShape } from "../support/oauth-setup-issuer.ts";
import { appsManifest } from "../support/apps-release.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const Redirect = Schema.Struct({
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const Failure = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
const Echo = Schema.Struct({
  refreshed: Schema.Boolean,
  authorization: Schema.NullOr(Schema.String),
});
const ScopeEcho = Schema.Struct({ ...Echo.fields, scope: Schema.String });
const SetupStatus = Schema.Struct({ status: Schema.String });
const client = { clientId: "token-shape-client", clientSecret: "synthetic-manual-secret" };

/** Slack's `oauth.v2.access` answer for a bot install with token rotation. */
const slack: TokenShape = (tokens) => ({
  ok: true,
  app_id: "A0SYNTHETIC",
  authed_user: { id: "U0SYNTHETIC" },
  scope: "read,write",
  token_type: "bot",
  access_token: tokens.access_token,
  bot_user_id: "U0SYNTHETICBOT",
  team: { id: "T0SYNTHETIC", name: "Synthetic" },
  enterprise: null,
  is_enterprise_install: false,
  ...(tokens.expires_in === undefined ? {} : { expires_in: tokens.expires_in }),
  ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
});
/** Slack's `oauth.v2.access` answer for a user-only install: the grant is under `authed_user`. */
const slackUser: TokenShape = (tokens) => ({
  ok: true,
  app_id: "A0SYNTHETIC",
  authed_user: {
    id: "U0SYNTHETIC",
    scope: "search:read,chat:write",
    access_token: tokens.access_token,
    token_type: "user",
    ...(tokens.expires_in === undefined ? {} : { expires_in: tokens.expires_in }),
    ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
  },
  team: { id: "T0SYNTHETIC", name: "Synthetic" },
  enterprise: null,
  is_enterprise_install: false,
});
/** Shopify's expiring offline token: no `token_type`, comma-separated scopes. */
const shopify: TokenShape = (tokens) => ({
  access_token: tokens.access_token,
  scope: "read_products,write_orders",
  ...(tokens.expires_in === undefined ? {} : { expires_in: tokens.expires_in }),
  ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
  refresh_token_expires_in: 7776000,
});
/** Mailchimp: no `token_type`, no lifetime, and a null scope. */
const mailchimp: TokenShape = (tokens) => ({ access_token: tokens.access_token, scope: null });
/** Optional members sent as null. A refresh keeps the previous refresh token. */
const nullMembers: TokenShape = (tokens, refreshing) => ({
  ...tokens,
  refresh_token: refreshing ? null : tokens.refresh_token,
  scope: null,
  id_token: null,
});
/** No lifetime, no refresh token and an empty ID token. */
const nullLifetime: TokenShape = (tokens) => ({
  access_token: tokens.access_token,
  token_type: "bearer",
  expires_in: null,
  refresh_token: null,
  id_token: "",
});
/** Scopes as a JSON array. */
const scopeArray: TokenShape = (tokens) => ({ ...tokens, scope: ["read", "write"] });
/** The given scope on sign-in and on renewal; null sends `scope: null`. */
const scoped =
  (signIn: string, renewal: string | null): TokenShape =>
  (tokens, refreshing) => ({ ...tokens, scope: refreshing ? renewal : signIn });
/** Answer sign-in in the standard shape and renewals in the given one. */
const onRenewal =
  (shape: TokenShape): TokenShape =>
  (tokens, refreshing) =>
    refreshing ? shape(tokens, refreshing) : tokens;
/** A DPoP-bound token on sign-in or on renewal; Executor cannot create DPoP proofs. */
const dpop =
  (on: "exchange" | "refresh"): TokenShape =>
  (tokens, refreshing) =>
    refreshing === (on === "refresh") ? { ...tokens, token_type: "DPoP" } : tokens;

/**
 * Deploy an app whose only query presents the account's token to the issuer, with helpers that
 * sign a new profile in and call that query. With `scope`, the provider declares a response that
 * requires a string `scope` and the query echoes the scope app code sees.
 */
const serviceApp = (
  issuer: Effect.Success<typeof oauthSetupIssuer>,
  kind: "declared" | "discovered",
  options: {
    readonly scope?: boolean;
    /** Further OAuth options the provider declares. */
    readonly oauth?: Readonly<Record<string, unknown>>;
  } = {},
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      http = yield* HttpClient.HttpClient;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const oauth = {
      ...(kind === "declared"
        ? {
            authorizationUrl: `${issuer.origin}/authorize`,
            tokenUrl: `${issuer.origin}/token`,
            scopes: ["openid", "read"],
          }
        : // Authorization-server discovery and dynamic registration; the resource advertises nothing.
          { discover: issuer.origin, scopes: ["openid", "read"] }),
      ...options.oauth,
    };
    const method =
      options.scope === true
        ? `oauth2({ ...${JSON.stringify(oauth)}, response: object({ access_token: string(), scope: string() }) })`
        : `oauth2(${JSON.stringify(oauth)})`;
    const echo =
      options.scope === true
        ? "({ ...(await result.json()), scope: accounts.service.fields.scope })"
        : "result.json()";

    const name = `Token shapes, ${kind} ${randomUUID().slice(0, 8)}`;
    const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name,
      files: [
        {
          path: "index.ts",
          content: `import { defineApp, defineProvider, oauth2, query, object, string, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: ${method} } });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({ tools: router({ read: query({ input: object({}) }, async ({ fetch }) => {
  const result = await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } });
  return ${echo};
}) }) }));
`,
        },
        appsManifest,
      ],
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    const app = yield* body(Resource, imported);
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
    );

    /** Sign a new profile's account in through the issuer and complete the callback. */
    const signIn = (label: string) =>
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
            label,
            ...(kind === "declared" ? { client } : {}),
          },
        );
        expect(started.status, `${label}: ${JSON.stringify(started.body)}`).toBe(200);
        const { authorizationUrl, redirectUri } = yield* body(Redirect, started);
        if (kind === "declared") yield* issuer.allowClient({ ...client, redirect: redirectUri });
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
        const exchanges = (yield* issuer.metrics).tokenExchanges;
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
          // Selecting the account queues profile setup, whose live read of the app resolves the
          // account and may renew its token. Wait until it is done so each call below is the
          // only renewal the issuer sees.
          yield* api
            .request(actors.owner, "GET", `${prefix}/apps/${app.id}/profiles/${profile.id}`)
            .pipe(
              Effect.flatMap((response) => body(SetupStatus, response)),
              Effect.flatMap((current) =>
                current.status !== "pending"
                  ? Effect.void
                  : Effect.fail(new Error(`${label}: profile setup has not finished`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
            );
        }
        expect((yield* issuer.metrics).tokenExchanges, label).toBe(exchanges + 1);
        return { profile, completed, failure: yield* body(Failure, completed) };
      });

    /** Call the app's query, which presents the account's access token to the issuer. */
    const read = (signedIn: { readonly profile: { readonly id: string } }) =>
      Effect.gen(function* () {
        const before = (yield* issuer.metrics).refreshes;
        const response = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/tools/call`,
          { profile: signedIn.profile.id, tool: "read", kind: "query", input: {} },
        );
        return { response, refreshes: (yield* issuer.metrics).refreshes - before };
      });

    return { signIn, read };
  });

/** Sign in and renew with each shape through declared endpoints or discovery. */
const tokenResponses = (kind: "declared" | "discovered") => (context: TestContext) =>
  withHostedCase(
    context,
    Effect.gen(function* () {
      const issuer = yield* oauthSetupIssuer;
      const { signIn, read } = yield* serviceApp(issuer, kind);

      const accepted: ReadonlyArray<{
        readonly name: string;
        readonly tokenShape: TokenShape;
        /** Tokens inside the host's refresh window renew on the first call. */
        readonly renews: boolean;
      }> = [
        { name: "Slack bot token", tokenShape: slack, renews: true },
        { name: "Shopify without token type", tokenShape: shopify, renews: true },
        { name: "Mailchimp null scope", tokenShape: mailchimp, renews: false },
        { name: "Null optional members", tokenShape: nullMembers, renews: true },
        { name: "Null lifetime and refresh token", tokenShape: nullLifetime, renews: false },
        { name: "Scope array", tokenShape: scopeArray, renews: true },
        // Sign-in answers in the standard shape; only renewals use the service's shape.
        { name: "Slack bot token on renewal", tokenShape: onRenewal(slack), renews: true },
        { name: "Null members on renewal", tokenShape: onRenewal(nullMembers), renews: true },
      ];
      for (const scenario of accepted) {
        const label = scenario.name;
        yield* issuer.configure({
          tokenShape: scenario.tokenShape,
          refreshTokens: true,
          // Inside the host's 30-second refresh window, so each call renews once.
          expiresIn: 10,
        });
        const signedIn = yield* signIn(label);
        expect(signedIn.completed.status, `${label}: ${JSON.stringify(signedIn.failure)}`).toBe(
          200,
        );
        // Renew twice: the second renewal presents the refresh token the first one kept.
        const presented: string[] = [];
        for (const call of [1, 2]) {
          const { response, refreshes } = yield* read(signedIn);
          expect(response.status, `${label} call ${call}: ${JSON.stringify(response.body)}`).toBe(
            200,
          );
          const echo = yield* body(Echo, response);
          expect(echo.refreshed, `${label} call ${call}`).toBe(scenario.renews);
          expect(refreshes, `${label} call ${call}`).toBe(scenario.renews ? 1 : 0);
          expect(echo.authorization, `${label} call ${call}`).toMatch(
            scenario.renews
              ? /^Bearer synthetic-refreshed-token-\d+$/
              : /^Bearer synthetic-access-token$/,
          );
          presented.push(echo.authorization ?? "");
        }
        if (scenario.renews) expect(presented[1], label).not.toBe(presented[0]);
      }

      // Executor sends every token as Bearer and cannot create DPoP proofs.
      yield* issuer.configure({
        tokenShape: dpop("exchange"),
        refreshTokens: true,
        expiresIn: 10,
      });
      const dpopSignIn = yield* signIn("DPoP sign-in");
      expect(dpopSignIn.completed.status, JSON.stringify(dpopSignIn.failure)).toBe(400);
      expect(dpopSignIn.failure).toEqual({
        _tag: "OAuthCompletionFailed",
        reason: "unsupported",
      });

      // A DPoP token on renewal is refused without ending the grant. While the sign-in token is
      // still valid, the call keeps using it and every call renews again.
      yield* issuer.configure({ tokenShape: dpop("refresh") });
      const dpopRenewal = yield* signIn("DPoP renewal");
      expect(dpopRenewal.completed.status, JSON.stringify(dpopRenewal.failure)).toBe(200);
      for (const call of [1, 2]) {
        const { response, refreshes } = yield* read(dpopRenewal);
        expect(refreshes, `DPoP renewal call ${call}`).toBe(1);
        expect(response.status, `DPoP renewal call ${call}: ${JSON.stringify(response.body)}`).toBe(
          200,
        );
        expect(yield* body(Echo, response), `DPoP renewal call ${call}`).toEqual({
          refreshed: false,
          authorization: "Bearer synthetic-access-token",
        });
      }
      // Once the sign-in token has expired, the refused renewal fails the call.
      yield* issuer.configure({ expiresIn: 1 });
      const dpopExpired = yield* signIn("DPoP renewal after expiry");
      expect(dpopExpired.completed.status, JSON.stringify(dpopExpired.failure)).toBe(200);
      yield* Effect.sleep("1200 millis");
      const { response, refreshes } = yield* read(dpopExpired);
      expect(refreshes).toBe(1);
      expect(response.status, JSON.stringify(response.body)).toBe(502);
      const failure = JSON.stringify(response.body);
      expect(failure).toContain("OAuthRenewalFailed");
      expect(failure).toContain("token_type");
    }),
  );

/**
 * An empty `scope` is a granted scope, not an absent one: app code sees it after sign-in and
 * after a renewal that narrows a nonempty scope. A null scope on renewal keeps the granted one.
 */
const emptyScope = (context: TestContext) =>
  withHostedCase(
    context,
    Effect.gen(function* () {
      const issuer = yield* oauthSetupIssuer;
      const { signIn, read } = yield* serviceApp(issuer, "declared", { scope: true });
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly tokenShape: TokenShape;
        readonly renews: boolean;
        readonly scope: string;
      }> = [
        { name: "Empty scope on sign-in", tokenShape: scoped("", ""), renews: false, scope: "" },
        {
          name: "Empty scope on renewal",
          tokenShape: scoped("openid read", ""),
          renews: true,
          scope: "",
        },
        {
          name: "Null scope on renewal",
          tokenShape: scoped("openid read", null),
          renews: true,
          scope: "openid read",
        },
      ];
      for (const scenario of cases) {
        const label = scenario.name;
        yield* issuer.configure({
          tokenShape: scenario.tokenShape,
          refreshTokens: scenario.renews,
          // Inside the host's 30-second refresh window when renewing; otherwise outside it.
          expiresIn: scenario.renews ? 10 : 3600,
        });
        const signedIn = yield* signIn(label);
        expect(signedIn.completed.status, `${label}: ${JSON.stringify(signedIn.failure)}`).toBe(
          200,
        );
        const { response } = yield* read(signedIn);
        expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(200);
        const echo = yield* body(ScopeEcho, response);
        expect(echo.refreshed, label).toBe(scenario.renews);
        expect(echo.scope, label).toBe(scenario.scope);
      }
    }),
  );

/**
 * A provider that declares `tokenResponse: { path: "authed_user" }` signs in and renews with
 * Slack's user-only response, and app code sees the nested grant's scopes space-separated. A
 * top-level grant with a scope still wins. Without the option the nested grant is not read.
 */
const nestedTokenResponse = (context: TestContext) =>
  withHostedCase(
    context,
    Effect.gen(function* () {
      const issuer = yield* oauthSetupIssuer;
      const nested = yield* serviceApp(issuer, "declared", {
        scope: true,
        oauth: { tokenResponse: { path: "authed_user" } },
      });
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly tokenShape: TokenShape;
        readonly scope: string;
      }> = [
        { name: "Slack user token", tokenShape: slackUser, scope: "search:read chat:write" },
        // A bot install answers with a top-level grant and scope, and only the user's ID nested.
        { name: "Slack bot token beside a nested user", tokenShape: slack, scope: "read,write" },
      ];
      for (const scenario of cases) {
        const label = scenario.name;
        yield* issuer.configure({
          tokenShape: scenario.tokenShape,
          refreshTokens: true,
          // Inside the host's 30-second refresh window, so each call renews once.
          expiresIn: 10,
        });
        const signedIn = yield* nested.signIn(label);
        expect(signedIn.completed.status, `${label}: ${JSON.stringify(signedIn.failure)}`).toBe(
          200,
        );
        // Renew twice: the second renewal presents the refresh token the first one kept.
        const presented: string[] = [];
        for (const call of [1, 2]) {
          const { response, refreshes } = yield* nested.read(signedIn);
          expect(response.status, `${label} call ${call}: ${JSON.stringify(response.body)}`).toBe(
            200,
          );
          expect(refreshes, `${label} call ${call}`).toBe(1);
          const echo = yield* body(ScopeEcho, response);
          expect(echo.refreshed, `${label} call ${call}`).toBe(true);
          expect(echo.authorization, `${label} call ${call}`).toMatch(
            /^Bearer synthetic-refreshed-token-\d+$/,
          );
          expect(echo.scope, `${label} call ${call}`).toBe(scenario.scope);
          presented.push(echo.authorization ?? "");
        }
        expect(presented[1], label).not.toBe(presented[0]);
      }

      // The same response without the declared option has no access token Executor can read.
      const standard = yield* serviceApp(issuer, "declared", { scope: true });
      yield* issuer.configure({ tokenShape: slackUser, refreshTokens: true, expiresIn: 10 });
      const refused = yield* standard.signIn("Slack user token without the option");
      expect(refused.completed.status, JSON.stringify(refused.failure)).toBe(400);
      expect(refused.failure._tag).toBe("OAuthCompletionFailed");
    }),
  );

/**
 * A provider that declares `tokenRequestFormat: "json"` signs in and renews against a service
 * that reads only JSON token requests. Without the option, the form request is refused.
 */
const jsonTokenRequests = (context: TestContext) =>
  withHostedCase(
    context,
    Effect.gen(function* () {
      const issuer = yield* oauthSetupIssuer;
      yield* issuer.configure({ tokenRequestFormat: "json", refreshTokens: true, expiresIn: 10 });
      const json = yield* serviceApp(issuer, "declared", {
        oauth: { tokenRequestFormat: "json" },
      });
      const sent = (yield* issuer.metrics).tokenContentTypes.length;
      const signedIn = yield* json.signIn("JSON token requests");
      expect(
        signedIn.completed.status,
        `${JSON.stringify(signedIn.failure)} checks=${JSON.stringify((yield* issuer.metrics).tokenChecks)}`,
      ).toBe(200);
      for (const call of [1, 2]) {
        const { response, refreshes } = yield* json.read(signedIn);
        expect(response.status, `call ${call}: ${JSON.stringify(response.body)}`).toBe(200);
        expect(refreshes, `call ${call}`).toBe(1);
        expect(
          (yield* body(Echo, response)).authorization,
          `call ${call}: ${JSON.stringify((yield* issuer.metrics).refreshChecks)}`,
        ).toMatch(/^Bearer synthetic-refreshed-token-\d+$/);
      }
      // The exchange and every renewal, including any during profile setup, were JSON.
      const types = (yield* issuer.metrics).tokenContentTypes.slice(sent);
      expect(types.length).toBeGreaterThanOrEqual(3);
      expect(types).toEqual(types.map(() => "application/json"));

      const form = yield* serviceApp(issuer, "declared");
      const refused = yield* form.signIn("Form token request");
      expect(refused.completed.status, JSON.stringify(refused.failure)).toBe(400);
      expect(refused.failure._tag).toBe("OAuthCompletionFailed");
      expect((yield* issuer.metrics).tokenContentTypes.at(-1)).toBe(
        "application/x-www-form-urlencoded",
      );
    }),
  );

layer(HostedLive, { excludeTestServices: true })("OAuth provider token responses", (it) => {
  it.effect(scenarios.oauthDeclaredTokenResponses.title, tokenResponses("declared"));
  it.effect(scenarios.oauthDiscoveredTokenResponses.title, tokenResponses("discovered"));
  it.effect(scenarios.oauthEmptyTokenScope.title, emptyScope);
  it.effect(scenarios.oauthNestedTokenResponse.title, nestedTokenResponse);
  it.effect(scenarios.oauthJsonTokenRequests.title, jsonTokenRequests);
});
