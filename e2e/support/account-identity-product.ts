/** Public local APIs used by the identity scenarios, including the real OAuth callback and app invocation. */
import { expect } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Api, body, type Session } from "./api.ts";
import { Target } from "./platform.ts";
import { appsManifest } from "./apps-release.ts";

export const IdentityAccount = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  identity: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, name: Schema.String, label: Schema.String }),
  ),
});
const Resource = Schema.Struct({ id: Schema.String });
const Published = Schema.Struct({ app: Resource });
const Started = Schema.Struct({ authorizationUrl: Schema.String });

export const accountIdentityProduct = Effect.gen(function* () {
  const api = yield* Api,
    target = yield* Target,
    http = yield* HttpClient.HttpClient;
  const raw = yield* api.session();
  const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
  const agent: Session = {
    ...raw,
    send: (method, path, data, extra = {}) => {
      const { origin: _origin, ...rest } = extra;
      return raw.send(method, path, data, { ...rest, ...headers });
    },
  };
  const apps: string[] = [],
    accounts = new Set<string>();
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const app of apps) yield* api.request(agent, "DELETE", `/v1/apps/${app}`);
      for (const account of accounts)
        yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
    }).pipe(Effect.orDie),
  );
  const request = (method: "GET" | "POST" | "DELETE", path: string, data?: unknown) =>
    api.request(agent, method, path, data);
  const deploy = (
    origin: string,
    name: string,
    scopes: string[],
    extra: object = {},
    existing?: string,
  ) =>
    Effect.gen(function* () {
      const config = {
        authorizationUrl: origin + "/authorize",
        tokenUrl: origin + "/token",
        revocationUrl: origin + "/revoke",
        tokenEndpointAuthMethod: "none",
        scopes,
        identity: { issuer: origin, name: "Fixture identity" },
        ...extra,
      };
      const response = yield* request("POST", "/v1/apps/deploy", {
        owner: "local",
        ...(existing === undefined ? { name } : { app: existing }),
        files: [
          appsManifest,
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2(${JSON.stringify(config)}) } });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({ tools: router({
  read: query({ input: object({}) }, async ({ fetch }) => await (await fetch(${JSON.stringify(origin + "/resource")}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } })).json()),
}) }));`,
          },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const { app } = yield* body(Published, response);
      apps.push(app.id);
      return app.id;
    });
  const connection = (app: string, account?: string) =>
    Effect.gen(function* () {
      const response = yield* request("POST", "/v1/account-connections", {
        owner: "ignored-owner",
        target: { app, requirement: "service" },
        ...(account === undefined ? {} : { account }),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (yield* body(Resource, response)).id;
    });
  const consent = (connection: string, clientId = "synthetic-client") =>
    Effect.gen(function* () {
      const started = yield* request("POST", "/v1/account-connections/oauth/start", {
        connection,
        method: "oauth",
        redirectUri: target.metadata.origin + "/api/oauth/callback",
        client: { clientId },
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const { authorizationUrl } = yield* body(Started, started);
      const callback = yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* HttpClient.withScope(http).get(authorizationUrl);
          expect(response.status).toBe(302);
          const location = response.headers.location;
          if (location === undefined) return yield* Effect.die("Issuer omitted callback");
          return location;
        }),
      ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      return yield* request("POST", "/v1/account-connections/oauth/complete", {
        connection,
        callbackUrl: callback,
      });
    });
  const connect = (app: string) =>
    Effect.gen(function* () {
      const pending = yield* connection(app);
      const response = yield* consent(pending);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const account = yield* body(IdentityAccount, response);
      accounts.add(account.id);
      return yield* body(IdentityAccount, yield* request("GET", `/v1/accounts/${account.id}`));
    });
  const reuse = (app: string, account: string) =>
    Effect.gen(function* () {
      const pending = yield* connection(app);
      const response = yield* request("POST", "/v1/account-connections/oauth/reuse", {
        connection: pending,
        account,
        method: "oauth",
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const result = yield* body(
        Schema.Union([
          Schema.Struct({ status: Schema.Literal("completed"), account: IdentityAccount }),
          Schema.Struct({ status: Schema.Literal("consent-required"), reason: Schema.String }),
        ]),
        response,
      );
      if (result.status === "completed") accounts.add(result.account.id);
      return result;
    });
  return {
    request,
    deploy,
    connection,
    consent,
    connect,
    reuse,
    remove: (account: string) => request("DELETE", `/v1/accounts/${account}`),
    read: (app: string) => request("POST", "/v1/tools/call", { app, tool: "read", input: {} }),
  };
});
