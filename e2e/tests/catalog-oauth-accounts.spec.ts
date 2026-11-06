/** Canonical eligibility is covered separately; only issuer URLs and placement change here. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import type { OperatorSettings } from "../support/managed-server.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { serverControl } from "../support/server-control.ts";
import {
  catalogOAuthFixtures,
  catalogOAuthCallback,
} from "../support/catalog-oauth-fixtures.ts";
import { scenarios } from "../test-plan.ts";

const Redirect = Schema.Struct({ authorizationUrl: Schema.String, redirectUri: Schema.String });
const Access = Schema.Struct({ revision: Schema.String });
const restartWith = (settings: typeof OperatorSettings.Type) =>
  Effect.gen(function* () {
    yield* serverControl("stop");
    yield* serverControl("environment", 200, settings);
    yield* serverControl("start");
  });

layer(HostedLive, { excludeTestServices: true })("Catalog OAuth accounts", (it) => {
  it.effect(scenarios.catalogOAuthAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        yield* Effect.addFinalizer(() =>
          restartWith({
            EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID: "",
            EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET: "",
          }).pipe(Effect.orDie),
        );
        for (const client of catalogOAuthFixtures) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const issuer = yield* oauthSetupIssuer;
              const auth = client.id === "NOTION" ? "client_secret_basic" : "client_secret_post";
              yield* issuer.configure({
                registration: false,
                scopes: client.scopes,
                authMethods: [auth],
                tokenRequestFormat: client.id === "TODOIST" ? "form" : "json",
              });
              const server = {
                ...client.server,
                authorizationUrl: `${issuer.origin}/authorize`,
                tokenUrl: `${issuer.origin}/token`,
              };
              // The existing operator fixture seam retains the vendor's format, auth and scopes.
              yield* restartWith({
                EXECUTOR_OAUTH_CALLBACK_URL: catalogOAuthCallback,
                EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([
                  {
                    id: "synthetic-mail",
                    label: `Synthetic ${client.name} shared client`,
                    server,
                    tokenEndpointAuthMethod: auth,
                    defaultScopes: client.scopes,
                    allowedScopes: client.scopes,
                    placement: { hosts: [new URL(issuer.origin).host] },
                  },
                ]),
                EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID: "catalog-shared-client",
                EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET: "catalog-shared-secret",
              });
              const source = `import { defineApp, defineProvider, oauth2, router } from "apps";
    const service = defineProvider({ name: ${JSON.stringify(client.name)}, hosts: [${JSON.stringify(new URL(issuer.origin).host)}], auth: {
      oauth: oauth2(${JSON.stringify({ ...server, scopes: client.scopes })}),
    } });
    export default defineApp({ user: { accounts: { service } } }, { tools: router({}) });`;
              const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
                name: `${client.name} personal grants ${randomUUID().slice(0, 8)}`,
                files: [{ path: "index.ts", content: source }, appsManifest],
              });
              expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
              const app = yield* body(Resource, deployed);
              const path = `${prefix}/apps/${app.id}`;
              yield* Effect.addFinalizer(() =>
                api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
              );
              const access = yield* body(
                Access,
                yield* api.request(actors.owner, "GET", `${path}/access`),
              );
              const shared = yield* api.request(actors.owner, "PATCH", `${path}/access`, {
                revision: access.revision,
                audience: { kind: "everyone" },
              });
              expect(shared.status, JSON.stringify(shared.body)).toBe(200);
              const accounts: string[] = [];
              for (const actor of [actors.owner, actors.member]) {
                const opened = yield* api.request(
                  actor,
                  "POST",
                  connectionsPath(path, "user", "service"),
                  {},
                );
                expect(opened.status, JSON.stringify(opened.body)).toBe(200);
                const connection = yield* body(Resource, opened);
                const started = yield* api.request(
                  actor,
                  "POST",
                  `${prefix}/connections/${connection.id}/oauth/start`,
                  { method: "oauth" },
                );
                expect(started.status, JSON.stringify(started.body)).toBe(200);
                const redirect = yield* body(Redirect, started);
                const url = new URL(redirect.authorizationUrl);
                expect(url.searchParams.get("client_id")).toBe("catalog-shared-client");
                expect(url.searchParams.get("redirect_uri")).toBe(catalogOAuthCallback);
                expect(redirect.redirectUri).toBe(catalogOAuthCallback);
                yield* issuer.allowClient({
                  clientId: "catalog-shared-client",
                  clientSecret: "catalog-shared-secret",
                  redirect: redirect.redirectUri,
                  methods: [auth],
                });
                const callback = yield* Effect.scoped(
                  Effect.gen(function* () {
                    const consent = yield* HttpClient.withScope(http).get(redirect.authorizationUrl);
                    expect(consent.status).toBe(302);
                    const location = consent.headers.location;
                    if (location === undefined) return yield* Effect.die("Missing consent callback");
                    return location;
                  }),
                ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
                const completed = yield* api.request(
                  actor,
                  "POST",
                  `${prefix}/connections/${connection.id}/oauth/complete`,
                  { callbackUrl: callback },
                );
                expect(completed.status, JSON.stringify(completed.body)).toBe(200);
                const account = (yield* body(Resource, completed)).id;
                accounts.push(account);
                yield* Effect.addFinalizer(() =>
                  api.request(actor, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
                );
                expect(
                  (yield* api.request(actor, "GET", `${prefix}/accounts/${account}`)).status,
                ).toBe(200);
              }
              expect(accounts).toHaveLength(2);
              expect(accounts[0]).not.toBe(accounts[1]);
              expect([403, 404]).toContain(
                (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${accounts[1]}`)).status,
              );
              expect([403, 404]).toContain(
                (yield* api.request(actors.member, "GET", `${prefix}/accounts/${accounts[0]}`)).status,
              );
              const metrics = yield* issuer.metrics;
              expect(metrics.tokenExchanges).toBe(2);
              expect(metrics.tokenChecks).toMatchObject({
                format: true,
                authMethod: true,
                authSecret: true,
              });
            }),
          );
        }
      }),
    ),
  );
});
