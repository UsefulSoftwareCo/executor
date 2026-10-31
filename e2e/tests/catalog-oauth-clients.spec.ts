/** Reviewed catalog endpoints select an optional operator client without contacting the vendor. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import type { OperatorSettings } from "../support/managed-server.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";
import {
  catalogOAuthFixtures as clients,
  catalogOAuthCallback,
} from "../support/catalog-oauth-fixtures.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Setup = Schema.Struct({
  mode: Schema.String,
  scopes: Schema.Array(Schema.String),
  firstParty: Schema.optional(Schema.Struct({ label: Schema.String })),
});
const Redirect = Schema.Struct({
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const restartWith = (settings: typeof OperatorSettings.Type) =>
  Effect.gen(function* () {
    yield* serverControl("stop");
    yield* serverControl("environment", 200, settings);
    yield* serverControl("start");
  });

layer(HostedLive, { excludeTestServices: true })("Catalog OAuth clients", (it) => {
  it.effect(scenarios.catalogOAuthClients.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const cleared = {
          EXECUTOR_OAUTH_NOTION_CLIENT_ID: "",
          EXECUTOR_OAUTH_NOTION_CLIENT_SECRET: "",
          EXECUTOR_OAUTH_TODOIST_CLIENT_ID: "",
          EXECUTOR_OAUTH_TODOIST_CLIENT_SECRET: "",
          EXECUTOR_OAUTH_TRELLO_CLIENT_ID: "",
          EXECUTOR_OAUTH_TRELLO_CLIENT_SECRET: "",
        };
        yield* Effect.addFinalizer(() => restartWith(cleared).pipe(Effect.orDie));
        const deploy = (client: (typeof clients)[number], variant = "matched") =>
          Effect.gen(function* () {
            const server =
              variant === "elsewhere"
                ? { ...client.server, tokenUrl: "https://unrelated.example.test/token" }
                : client.server;
            const scopes =
              variant === "wider" ? [...client.scopes, "unreviewed:scope"] : client.scopes;
            const content = `import { defineApp, defineProvider, oauth2, secrets, object, string, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(client.name)}, hosts: [${JSON.stringify(client.host)}], auth: {
  oauth: oauth2(${JSON.stringify({ ...server, scopes })}),
  key: secrets({ label: "Paste a token", fields: object({ token: string() }) }),
} });
export default defineApp({ user: { accounts: { service } } }, { tools: router({}) });`;
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${client.name} ${variant} ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content }, appsManifest],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            const path = `${prefix}/apps/${app.id}`;
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
            );
            const setup = yield* body(
              Setup,
              yield* api.request(
                actors.owner,
                "GET",
                `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
              ),
            );
            const open = Effect.gen(function* () {
              const opened = yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(path, "user", "service"),
                {},
              );
              expect(opened.status, JSON.stringify(opened.body)).toBe(200);
              return (yield* body(Resource, opened)).id;
            });
            const start = (connection: string, own = false) =>
              api.request(actors.owner, "POST", `${prefix}/connections/${connection}/oauth/start`, {
                method: "oauth",
                ...(own
                  ? { client: { clientId: "personal-client", clientSecret: "personal-secret" } }
                  : {}),
              });
            return { setup, open, start };
          });

        // Without credentials, the reviewed clients are not offered.
        yield* restartWith({ ...cleared, EXECUTOR_OAUTH_CALLBACK_URL: catalogOAuthCallback });
        for (const client of clients) {
          const absent = yield* deploy(client);
          expect(absent.setup.firstParty, client.name).toBeUndefined();
        }
        yield* restartWith({
          EXECUTOR_OAUTH_CALLBACK_URL: catalogOAuthCallback,
          EXECUTOR_OAUTH_NOTION_CLIENT_ID: "shared-NOTION",
          EXECUTOR_OAUTH_NOTION_CLIENT_SECRET: "shared-secret-NOTION",
          EXECUTOR_OAUTH_TODOIST_CLIENT_ID: "shared-TODOIST",
          EXECUTOR_OAUTH_TODOIST_CLIENT_SECRET: "shared-secret-TODOIST",
          EXECUTOR_OAUTH_TRELLO_CLIENT_ID: "shared-TRELLO",
          EXECUTOR_OAUTH_TRELLO_CLIENT_SECRET: "shared-secret-TRELLO",
        });
        for (const client of clients) {
          const matched = yield* deploy(client);
          expect(matched.setup.mode, client.name).toBe("automatic");
          expect(matched.setup.firstParty?.label, client.name).toMatch(
            new RegExp(` for ${client.name}$`),
          );
          const sharedConnection = yield* matched.open;
          const shared = yield* matched.start(sharedConnection);
          expect(shared.status, JSON.stringify(shared.body)).toBe(200);
          const sharedRedirect = yield* body(Redirect, shared);
          expect(sharedRedirect.redirectUri).toBe(catalogOAuthCallback);
          const sent = new URL(sharedRedirect.authorizationUrl);
          expect(sent.searchParams.get("redirect_uri")).toBe(catalogOAuthCallback);
          expect(`${sent.origin}${sent.pathname}`).toBe(client.server.authorizationUrl);
          expect(sent.searchParams.get("client_id")).toBe(`shared-${client.id}`);
          expect(sent.searchParams.get("scope") ?? "").toBe(client.scopes.join(client.separator));
          if (client.parameter.length > 0)
            expect(sent.searchParams.get(client.parameter[0]!)).toBe(client.parameter[1]);
          expect(JSON.stringify(shared.body)).not.toContain(`shared-secret-${client.id}`);
          const personal = yield* matched.start(yield* matched.open, true);
          expect(personal.status, JSON.stringify(personal.body)).toBe(200);
          const personalRedirect = yield* body(Redirect, personal);
          expect(personalRedirect.redirectUri).toBe(catalogOAuthCallback);
          const own = new URL(personalRedirect.authorizationUrl);
          expect(own.searchParams.get("redirect_uri")).toBe(catalogOAuthCallback);
          expect(own.searchParams.get("client_id")).toBe("personal-client");
          expect(own.searchParams.get("state")).not.toBe(sent.searchParams.get("state"));
          // The existing token method still saves a private account with a shared client enabled.
          const tokenConnection = yield* matched.open;
          const saved = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${tokenConnection}/submit`,
            { method: "key", label: client.name, fields: { token: "synthetic-personal-token" } },
          );
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          const account = (yield* body(Resource, saved)).id;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
          );
          expect([403, 404]).toContain(
            (yield* api.request(actors.member, "GET", `${prefix}/accounts/${account}`)).status,
          );
          for (const variant of ["elsewhere", "wider"]) {
            const refused = yield* deploy(client, variant);
            expect(refused.setup.firstParty, `${client.name} ${variant}`).toBeUndefined();
            expect((yield* refused.start(yield* refused.open)).body).toMatchObject({
              _tag: "OAuthClientUnavailable",
            });
          }
        }
      }),
    ),
  );
});
