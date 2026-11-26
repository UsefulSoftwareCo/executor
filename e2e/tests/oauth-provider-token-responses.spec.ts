import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import type { TestContext } from "vitest";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { linkedAccountIds, connectionsPath } from "../support/app-accounts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer, type TokenShape } from "../support/oauth-setup-issuer.ts";
import { appsManifest } from "../support/apps-release.ts";
import { settleWebhookSources } from "../support/webhook-sources.ts";
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
const client = { clientId: "token-shape-client", clientSecret: "synthetic-manual-secret" };

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
const slackDual: TokenShape = (tokens, refreshing) =>
  refreshing
    ? {
        access_token: tokens.access_token,
        token_type: "user",
        scope: "search:read,chat:write",
        ...(tokens.expires_in === undefined ? {} : { expires_in: tokens.expires_in }),
        ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
      }
    : {
        ...slack(tokens, false),
        access_token: "synthetic-bot-token",
        refresh_token: "synthetic-bot-refresh-token",
        authed_user: {
          id: "U0SYNTHETIC",
          scope: "search:read,chat:write",
          access_token: tokens.access_token,
          token_type: "user",
          ...(tokens.expires_in === undefined ? {} : { expires_in: tokens.expires_in }),
          ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
        },
      };
const shopify: TokenShape = (tokens) => ({
  access_token: tokens.access_token,
  scope: "read_products,write_orders",
  ...(tokens.expires_in === undefined ? {} : { expires_in: tokens.expires_in }),
  ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
  refresh_token_expires_in: 7776000,
});
const mailchimp: TokenShape = (tokens) => ({ access_token: tokens.access_token, scope: null });
const nullMembers: TokenShape = (tokens, refreshing) => ({
  ...tokens,
  refresh_token: refreshing ? null : tokens.refresh_token,
  scope: null,
  id_token: null,
});
const nullLifetime: TokenShape = (tokens) => ({
  access_token: tokens.access_token,
  token_type: "bearer",
  expires_in: null,
  refresh_token: null,
  id_token: "",
});
const scopeArray: TokenShape = (tokens) => ({ ...tokens, scope: ["read", "write"] });
const scoped =
  (signIn: string, renewal: string | null): TokenShape =>
  (tokens, refreshing) => ({ ...tokens, scope: refreshing ? renewal : signIn });
const onRenewal =
  (shape: TokenShape): TokenShape =>
  (tokens, refreshing) =>
    refreshing ? shape(tokens, refreshing) : tokens;
const dpop =
  (on: "exchange" | "refresh"): TokenShape =>
  (tokens, refreshing) =>
    refreshing === (on === "refresh") ? { ...tokens, token_type: "DPoP" } : tokens;

const serviceApp = (
  issuer: Effect.Success<typeof oauthSetupIssuer>,
  options: {
    readonly scope?: boolean;
    readonly oauth?: Readonly<Record<string, unknown>>;
  } = {},
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      http = yield* HttpClient.HttpClient;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const oauth = {
      authorizationUrl: `${issuer.origin}/authorize`,
      tokenUrl: `${issuer.origin}/token`,
      scopes: ["openid", "read"],
      ...options.oauth,
    };
    const method =
      options.scope === true
        ? `oauth2({ ...${JSON.stringify(oauth)}, response: object({ access_token: string(), scope: string() }) })`
        : `oauth2(${JSON.stringify(oauth)})`;
    const echo =
      options.scope === true
        ? "({ ...(await decodeJson(result, Resource)), scope: accounts.service.fields.scope })"
        : "decodeJson(result, Resource)";

    const name = `Token shapes ${randomUUID().slice(0, 8)}`;
    const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name,
      files: [
        {
          path: "index.ts",
          content: `import { boolean, decodeJson, defineApp, defineProvider, oauth2, query, object, string, router } from "apps";
import { never } from "apps/operations/approval";
const Resource = object({ refreshed: boolean(), authorization: string() });
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: ${method} } });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({ tools: router({ read: query({ input: object({}), approval: never() }, async ({ fetch }) => {
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

    const signIn = (label: string) =>
      Effect.gen(function* () {
        const connection = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
            {},
          ),
        );
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/start`,
          {
            method: "oauth",
            label,
            client,
          },
        );
        expect(started.status, `${label}: ${JSON.stringify(started.body)}`).toBe(200);
        const { authorizationUrl, redirectUri } = yield* body(Redirect, started);
        yield* issuer.allowClient({ ...client, redirect: redirectUri });
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
        let account: string | undefined;
        if (completed.status === 200) {
          account = (yield* body(Resource, completed)).id;
          const saved = account;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/accounts/${saved}`).pipe(Effect.orDie),
          );
          yield* settleWebhookSources(actors.owner, `${prefix}/apps/${app.id}`, (sources) =>
            sources.some((source) => source.account === saved && source.status !== "pending"),
          );
        }
        expect((yield* issuer.metrics).tokenExchanges, label).toBe(exchanges + 1);
        return { account, completed, failure: yield* body(Failure, completed) };
      });

    const read = (signedIn: { readonly account: string | undefined }) =>
      Effect.gen(function* () {
        if (signedIn.account === undefined)
          return yield* Effect.die("The sign-in saved no account");
        expect(yield* linkedAccountIds(actors.owner, `${prefix}/apps/${app.id}`)).toEqual([
          signedIn.account,
        ]);
        const before = (yield* issuer.metrics).refreshes;
        const response = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/tools/call`,
          {
            tool: "read",
            kind: "query",
            input: {},
          },
        );
        return { response, refreshes: (yield* issuer.metrics).refreshes - before };
      });

    return { signIn, read };
  });

const tokenResponses = (context: TestContext) =>
  withHostedCase(
    context,
    Effect.gen(function* () {
      const issuer = yield* oauthSetupIssuer;
      const { signIn, read } = yield* serviceApp(issuer);

      const accepted: ReadonlyArray<{
        readonly name: string;
        readonly tokenShape: TokenShape;
        readonly renews: boolean;
      }> = [
        { name: "Slack bot token", tokenShape: slack, renews: true },
        { name: "Shopify without token type", tokenShape: shopify, renews: true },
        { name: "Mailchimp null scope", tokenShape: mailchimp, renews: false },
        { name: "Null optional members", tokenShape: nullMembers, renews: true },
        { name: "Null lifetime and refresh token", tokenShape: nullLifetime, renews: false },
        { name: "Scope array", tokenShape: scopeArray, renews: true },
        { name: "Slack bot token on renewal", tokenShape: onRenewal(slack), renews: true },
        { name: "Null members on renewal", tokenShape: onRenewal(nullMembers), renews: true },
      ];
      for (const scenario of accepted) {
        const label = scenario.name;
        yield* issuer.configure({
          tokenShape: scenario.tokenShape,
          refreshTokens: true,
          expiresIn: 10,
        });
        const signedIn = yield* signIn(label);
        expect(signedIn.completed.status, `${label}: ${JSON.stringify(signedIn.failure)}`).toBe(
          200,
        );
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

const emptyScope = (context: TestContext) =>
  withHostedCase(
    context,
    Effect.gen(function* () {
      const issuer = yield* oauthSetupIssuer;
      const { signIn, read } = yield* serviceApp(issuer, { scope: true });
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

const nestedTokenResponse = (context: TestContext) =>
  withHostedCase(
    context,
    Effect.gen(function* () {
      const issuer = yield* oauthSetupIssuer;
      const nested = yield* serviceApp(issuer, {
        scope: true,
        oauth: { tokenResponse: { path: "authed_user" } },
      });
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly tokenShape: TokenShape;
        readonly scope: string;
      }> = [
        { name: "Slack user token", tokenShape: slackUser, scope: "search:read chat:write" },
        { name: "Slack bot token beside a nested user", tokenShape: slack, scope: "read,write" },
      ];
      for (const scenario of cases) {
        const label = scenario.name;
        yield* issuer.configure({
          tokenShape: scenario.tokenShape,
          refreshTokens: true,
          expiresIn: 10,
        });
        const signedIn = yield* nested.signIn(label);
        expect(signedIn.completed.status, `${label}: ${JSON.stringify(signedIn.failure)}`).toBe(
          200,
        );
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

      const standard = yield* serviceApp(issuer, { scope: true });
      yield* issuer.configure({ tokenShape: slackUser, refreshTokens: true, expiresIn: 10 });
      const refused = yield* standard.signIn("Slack user token without the option");
      expect(refused.completed.status, JSON.stringify(refused.failure)).toBe(400);
      expect(refused.failure._tag).toBe("OAuthCompletionFailed");

      const strict = yield* serviceApp(issuer, {
        scope: true,
        oauth: {
          tokenResponse: { path: "authed_user", requiredOnExchange: true },
        },
      });
      yield* issuer.configure({ tokenShape: slackDual, refreshTokens: true, expiresIn: 3600 });
      const dual = yield* strict.signIn("Strict nested user grant beside a bot grant");
      expect(dual.completed.status, JSON.stringify(dual.failure)).toBe(200);
      const initial = yield* strict.read(dual);
      expect(initial.response.status, JSON.stringify(initial.response.body)).toBe(200);
      expect(initial.refreshes).toBe(0);
      const initialEcho = yield* body(ScopeEcho, initial.response);
      expect(initialEcho.authorization).toBe("Bearer synthetic-access-token");
      expect(initialEcho.scope).toBe("search:read chat:write");
      yield* issuer.configure({ tokenShape: slackDual, refreshTokens: true, expiresIn: 10 });
      const refresh = yield* strict.signIn("Strict nested exchange with top-level refresh");
      expect(refresh.completed.status, JSON.stringify(refresh.failure)).toBe(200);
      const renewed = yield* strict.read(refresh);
      expect(renewed.response.status, JSON.stringify(renewed.response.body)).toBe(200);
      expect(renewed.refreshes).toBe(1);
      const renewedEcho = yield* body(ScopeEcho, renewed.response);
      expect(renewedEcho.refreshed).toBe(true);
      expect(renewedEcho.authorization).toMatch(/^Bearer synthetic-refreshed-token-\d+$/);
      expect(renewedEcho.scope).toBe("search:read,chat:write");
      yield* issuer.configure({ tokenShape: slack, refreshTokens: true, expiresIn: 3600 });
      const missing = yield* strict.signIn("Strict nested exchange missing a user grant");
      expect(missing.completed.status, JSON.stringify(missing.failure)).toBe(400);
      expect(missing.failure._tag).toBe("OAuthCompletionFailed");
    }),
  );

const jsonTokenRequests = (context: TestContext) =>
  withHostedCase(
    context,
    Effect.gen(function* () {
      const issuer = yield* oauthSetupIssuer;
      yield* issuer.configure({ tokenRequestFormat: "json", refreshTokens: true, expiresIn: 10 });
      const json = yield* serviceApp(issuer, {
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
      const types = (yield* issuer.metrics).tokenContentTypes.slice(sent);
      expect(types.length).toBeGreaterThanOrEqual(3);
      expect(types).toEqual(types.map(() => "application/json"));

      const form = yield* serviceApp(issuer);
      const refused = yield* form.signIn("Form token request");
      expect(refused.completed.status, JSON.stringify(refused.failure)).toBe(400);
      expect(refused.failure._tag).toBe("OAuthCompletionFailed");
      expect((yield* issuer.metrics).tokenContentTypes.at(-1)).toBe(
        "application/x-www-form-urlencoded",
      );
    }),
  );

layer(HostedLive, { excludeTestServices: true })("OAuth provider token responses", (it) => {
  it.effect(scenarios.oauthDeclaredTokenResponses.title, tokenResponses);
  it.effect(scenarios.oauthEmptyTokenScope.title, emptyScope);
  it.effect(scenarios.oauthNestedTokenResponse.title, nestedTokenResponse);
  it.effect(scenarios.oauthJsonTokenRequests.title, jsonTokenRequests);
});
