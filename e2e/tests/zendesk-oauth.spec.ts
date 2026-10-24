/** Hosted Zendesk OAuth uses only the configured tenant and each app member's own user account. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { accountLinks, connectionsPath } from "../support/app-accounts.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { serverControl } from "../support/server-control.ts";
import type { OperatorSettings } from "../support/managed-server.ts";
import { scenarios } from "../test-plan.ts";

const syntheticTenant = "synthetic-tenant";
const userSuppliedTenant = "user-supplied-tenant";
const clientId = "synthetic-zendesk-client";
const clientSecret = "synthetic-zendesk-secret";
const scopes = ["tickets:read", "tickets:write", "users:read"];

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
  }),
});
const Setup = Schema.Struct({
  mode: Schema.Literals(["automatic", "client-required"]),
  scopes: Schema.Array(Schema.String),
  firstParty: Schema.optional(Schema.Struct({ label: Schema.String })),
  tokenEndpointAuthMethod: Schema.optional(Schema.String),
});
const Connection = Schema.Struct({ id: Schema.String, redirectUri: Schema.String });
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});

const noZendeskSettings: typeof OperatorSettings.Type = {
  EXECUTOR_PRODUCT_NAME: "Synthetic Product",
  EXECUTOR_ZENDESK_SUBDOMAIN: "",
  EXECUTOR_OAUTH_ZENDESK_CLIENT_ID: "",
  EXECUTOR_OAUTH_ZENDESK_CLIENT_SECRET: "",
};
const configuredZendeskSettings: typeof OperatorSettings.Type = {
  EXECUTOR_PRODUCT_NAME: "Synthetic Product",
  EXECUTOR_ZENDESK_SUBDOMAIN: syntheticTenant,
  EXECUTOR_OAUTH_ZENDESK_CLIENT_ID: clientId,
  EXECUTOR_OAUTH_ZENDESK_CLIENT_SECRET: clientSecret,
};

const appSource = `import { defineApp, defineProvider, oauth2, router } from "apps";
const service = defineProvider({ name: "Zendesk", hosts: [${JSON.stringify(`${syntheticTenant}.zendesk.com`)}], auth: { oauth: oauth2({
  authorizationUrl: ${JSON.stringify(`https://${syntheticTenant}.zendesk.com/oauth/authorizations/new`)},
  tokenUrl: ${JSON.stringify(`https://${syntheticTenant}.zendesk.com/oauth/tokens`)},
  scopes: ${JSON.stringify(scopes)},
  tokenEndpointAuthMethod: "client_secret_post",
  tokenRequestFormat: "json",
}) } });
const untrusted = defineProvider({ name: "User supplied tenant", hosts: [${JSON.stringify(`${userSuppliedTenant}.zendesk.com`)}], auth: { oauth: oauth2({
  authorizationUrl: ${JSON.stringify(`https://${userSuppliedTenant}.zendesk.com/oauth/authorizations/new`)},
  tokenUrl: ${JSON.stringify(`https://${userSuppliedTenant}.zendesk.com/oauth/tokens`)},
  scopes: ${JSON.stringify(scopes)},
  tokenEndpointAuthMethod: "client_secret_post",
  tokenRequestFormat: "json",
}) } });
export default defineApp({ user: { accounts: { service, untrusted } } }, async () => ({ tools: router({}) }));
`;

layer(HostedLive, { excludeTestServices: true })("Hosted Zendesk OAuth", (it) => {
  it.effect(scenarios.zendeskHostedOAuth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const restartWith = (settings: typeof OperatorSettings.Type) =>
          Effect.gen(function* () {
            yield* serverControl("stop");
            yield* serverControl("environment", 200, settings);
            yield* serverControl("start");
          });
        yield* Effect.addFinalizer(() => restartWith(noZendeskSettings).pipe(Effect.orDie));

        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Zendesk ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: appSource }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );

        const setup = (provider: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/providers/${encodeURIComponent(provider)}/oauth/oauth/setup`,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Setup, response);
          });
        const unavailable = (provider: string) =>
          Effect.gen(function* () {
            const result = yield* setup(provider);
            expect(result.mode).toBe("client-required");
            expect(result.firstParty).toBeUndefined();
            return result;
          });

        const serviceRequirement = app.requirements.accounts.service;
        const untrustedRequirement = app.requirements.accounts.untrusted;
        if (serviceRequirement === undefined || untrustedRequirement === undefined)
          return yield* Effect.die("Zendesk app requirements were not deployed");
        const serviceProvider = serviceRequirement.provider;
        const untrustedProvider = untrustedRequirement.provider;
        yield* unavailable(serviceProvider);

        // Each missing host setting leaves the native client unavailable.
        for (const key of [
          "EXECUTOR_ZENDESK_SUBDOMAIN",
          "EXECUTOR_OAUTH_ZENDESK_CLIENT_ID",
          "EXECUTOR_OAUTH_ZENDESK_CLIENT_SECRET",
        ] as const) {
          yield* restartWith({ ...configuredZendeskSettings, [key]: "" });
          yield* unavailable(serviceProvider);
        }

        yield* restartWith(configuredZendeskSettings);
        const native = yield* setup(serviceProvider);
        expect(native).toMatchObject({
          mode: "automatic",
          scopes,
          firstParty: { label: "Synthetic Product for Zendesk" },
          tokenEndpointAuthMethod: "client_secret_post",
        });

        // A user-supplied provider cannot borrow the configured client's tenant or credentials.
        const untrusted = yield* unavailable(untrustedProvider);
        expect(JSON.stringify(untrusted)).not.toContain(clientId);
        expect(JSON.stringify(untrusted)).not.toContain(clientSecret);

        const connection = yield* body(
          Connection,
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
          { method: "oauth", label: "Synthetic Zendesk user" },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const redirect = yield* body(Redirect, started);
        const authorization = new URL(redirect.authorizationUrl);
        expect(`${authorization.origin}${authorization.pathname}`).toBe(
          `https://${syntheticTenant}.zendesk.com/oauth/authorizations/new`,
        );
        expect(authorization.searchParams.get("client_id")).toBe(clientId);
        expect(authorization.searchParams.get("redirect_uri")).toBe(connection.redirectUri);
        expect(authorization.searchParams.get("scope")).toBe(scopes.join(" "));
        expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43,}$/u);

        // Submit a synthetic consent denial through the public callback API; no browser or provider is contacted.
        const callback = new URL(redirect.redirectUri);
        callback.searchParams.set("error", "access_denied");
        callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
        const denied = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/complete`,
          { callbackUrl: callback.href },
        );
        expect(denied.status).toBe(400);
        expect(denied.body).toMatchObject({ _tag: "OAuthCompletionFailed", reason: "denied" });
        expect(yield* accountLinks(actors.owner, `${prefix}/apps/${app.id}`)).toEqual([]);
      }),
    ),
  );
});
