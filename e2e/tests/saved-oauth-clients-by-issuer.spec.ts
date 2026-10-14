/**
 * Versions before 4.0.10 saved OAuth clients under a digest of their owner, provider, method,
 * callback, issuer and scopes, so one client entered for two apps was saved twice.
 * `9_saved_oauth_clients_by_issuer` moves each saved record to its owner's client for the
 * authorization server its owner's accounts signed in at: the two records of one organization's
 * client become one stored client. A record whose credentials accounts of several owners hold goes
 * to the owner whose settings rebuild its key, and one no owner's settings rebuild stays where it
 * is. The product starts with data steps held in report mode, then applies them.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { mcpSdkVersion, withApps } from "../support/apps-release.ts";
import { TestLive, withHostedCase } from "../support/case.ts";
import { dataStepSummaries, nextDataStepSummary } from "../support/data-steps.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const step = "9_saved_oauth_clients_by_issuer";
const scopes = ["read"];

/** An MCP app whose provider declares its scopes, as most saved clients' providers did. */
const appFiles = (name: string, url: string) => [
  {
    path: "index.ts",
    content: `import { accountRouter, defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
import { provider } from "./provider.ts";

export default defineApp({ user: { accounts: { service: provider.many() } } }, async ({ user: { accounts }, cache, signal }) => ({
  tools: await accountRouter(accounts.service, async (account) => mcpRouter({
    url: ${JSON.stringify(url)},
    account,
    cache,
    headers: { Authorization: "Bearer " + account.fields.access_token },
    signal,
  }), { signal }),
}));
`,
  },
  {
    path: "provider.ts",
    content: `import { defineProvider, oauth2 } from "apps";

export const provider = defineProvider({
  name: ${JSON.stringify(name)},
  hosts: ${JSON.stringify([new URL(url).host])},
  auth: { oauth: oauth2({ discover: ${JSON.stringify(url)}, scopes: ${JSON.stringify(scopes)} }) },
});
`,
  },
  {
    path: "package.json",
    content: JSON.stringify({
      name: "saved-client-issuer-fixture",
      private: true,
      type: "module",
      dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
    }),
  },
];

const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const DeployedApp = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Account = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  provider: Schema.String,
  method: Schema.String,
});
const Directory = Schema.Struct({
  clients: Schema.Array(
    Schema.Struct({
      client: Schema.Struct({
        id: Schema.String,
        clientId: Schema.String,
        issuer: Schema.NullOr(Schema.String),
        source: Schema.String,
      }),
      access: Schema.Struct({ audience: Schema.Struct({ kind: Schema.String }) }),
    }),
  ),
});
const Options = Schema.Struct({
  issuer: Schema.String,
  clients: Schema.Array(Schema.Struct({ id: Schema.String })),
});

layer(TestLive, { excludeTestServices: true })("Saved OAuth clients by issuer", (it) => {
  it.effect(scenarios.savedOAuthClientsByIssuer.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          target = yield* Target,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const log = `${target.directory}/server.log`;
        yield* issuer.configure({ registration: false, tokenError: null });
        // One client someone entered for two services: the same ID and secret.
        const entered = {
          clientId: `entered-${randomUUID().slice(0, 8)}`,
          clientSecret: "synthetic-entered-secret",
        };

        /** Deploy an app of its own provider and sign in to it with the entered details. */
        const connect = (name: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files: appFiles(name, `${issuer.origin}/mcp`),
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(DeployedApp, deployed);
            const connection = yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
              {},
            );
            expect(connection.status, JSON.stringify(connection.body)).toBe(200);
            const { id } = yield* body(Schema.Struct({ id: Schema.String }), connection);
            const redirect = yield* body(
              Redirect,
              yield* api.request(actors.owner, "POST", `${prefix}/connections/${id}/oauth/start`, {
                method: "oauth",
                label: "Entered client",
                client: entered,
              }),
            );
            yield* issuer.allowClient({ ...entered, redirect: redirect.redirectUri });
            const callback = yield* Effect.scoped(
              Effect.gen(function* () {
                const response = yield* HttpClient.withScope(http).get(redirect.authorizationUrl);
                expect(response.status).toBe(302);
                const location = response.headers.location;
                if (location === undefined)
                  return yield* Effect.die("Issuer did not return a callback");
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${id}/oauth/complete`,
              { callbackUrl: callback },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            return { provider: app.requirements.accounts.service.provider, redirect };
          });

        const first = yield* connect(`Saved by issuer A ${randomUUID().slice(0, 8)}`);
        const second = yield* connect(`Saved by issuer B ${randomUUID().slice(0, 8)}`);
        // Entered details are kept only by each account's grant on hosted.
        expect(
          (yield* body(
            Directory,
            yield* api.request(actors.admin, "GET", `${prefix}/oauth-clients`),
          )).clients.filter((entry) => entry.client.clientId === entered.clientId),
        ).toEqual([]);

        const [rows = []] = yield* legacyStorage([
          {
            sql: `SELECT id, owner, provider, method FROM executor_accounts
              WHERE provider = ANY($1::text[]) ORDER BY provider`,
            params: [`{${[first.provider, second.provider].join(",")}}`],
          },
        ]);
        const accounts = Schema.decodeUnknownSync(Schema.Array(Account))(rows);
        const firstAccount = accounts.find((row) => row.provider === first.provider);
        const secondAccount = accounts.find((row) => row.provider === second.provider);
        if (firstAccount === undefined || secondAccount === undefined)
          return yield* Effect.die("Each service should have an account");
        /** The key an older version gave the client a service's sign-in saved. */
        const keyOf = (account: typeof Account.Type, redirectUri: string) =>
          `client_${createHash("sha256")
            .update(
              JSON.stringify([
                account.owner,
                account.provider,
                account.method,
                new URL(redirectUri).href,
                issuer.origin,
                null,
                [...scopes].sort(),
              ]),
            )
            .digest("hex")}`;
        const keyedFirst = keyOf(firstAccount, first.redirect.redirectUri);
        const keyedSecond = keyOf(secondAccount, second.redirect.redirectUri);
        // A key no holder's settings rebuild, like a public client a service returns to everyone.
        const unkeyed = `client_${randomBytes(32).toString("hex")}`;
        const registration = {
          client_id: entered.clientId,
          client_secret: entered.clientSecret,
          token_endpoint_auth_method: "client_secret_basic",
        };
        // Another owner's account holds the same details, so no record has one owner.
        const otherOwner = `organization:synthetic-other-${randomUUID().slice(0, 8)}`;
        const otherAccount = `acc_synthetic_other_${randomUUID().slice(0, 8)}`;
        const seen = (yield* dataStepSummaries(log, step)).length;
        yield* legacyStorage([
          {
            sql: `INSERT INTO executor_accounts
              (id, owner, provider, method, label, encrypted_credentials, credential_generation, created_at)
              SELECT $1, $2, provider, method, label, encrypted_credentials, credential_generation, created_at
              FROM executor_accounts WHERE id = $3`,
            params: [otherAccount, otherOwner, firstAccount.id],
          },
          {
            sql: `INSERT INTO executor_oauth_grants (id, encrypted, status, updated_at)
              SELECT $1, $2, status, updated_at FROM executor_oauth_grants WHERE id = $3`,
            params: [
              otherAccount,
              {
                sealed: {
                  id: otherAccount,
                  value: {
                    response: {},
                    fields: {},
                    server: {
                      issuer: issuer.origin,
                      authorization_endpoint: `${issuer.origin}/authorize`,
                      token_endpoint: `${issuer.origin}/token`,
                    },
                    client: registration,
                  },
                },
              },
              firstAccount.id,
            ],
          },
          {
            sql: `INSERT INTO executor_oauth_clients (id, encrypted) VALUES ($1, $2), ($3, $4), ($5, $6)`,
            params: [
              keyedFirst,
              {
                sealed: {
                  id: keyedFirst,
                  value: { ...registration, executor_source: "manual" },
                },
              },
              keyedSecond,
              {
                sealed: {
                  id: keyedSecond,
                  value: { ...registration, executor_source: "manual" },
                },
              },
              unkeyed,
              { sealed: { id: unkeyed, value: registration } },
            ],
          },
        ]);
        yield* serverControl("data-steps", 200, { mode: "apply" });
        yield* serverControl("start");

        const summary = yield* nextDataStepSummary(log, step, seen);
        expect(summary).toMatchObject({
          mode: "apply",
          status: "complete",
          outcomes: { moved: 1, duplicate: 1, ambiguous_owner: 1 },
        });
        // Both records are the organization's: its settings rebuild their keys.
        expect(summary.owners[firstAccount.owner]).toEqual({ moved: 1, duplicate: 1 });

        // The two records are one stored client for the server, usable by everyone.
        const moved = (yield* body(
          Directory,
          yield* api.request(actors.admin, "GET", `${prefix}/oauth-clients`),
        )).clients.filter((entry) => entry.client.clientId === entered.clientId);
        expect(moved).toHaveLength(1);
        const [client] = moved;
        expect(client?.client).toMatchObject({ issuer: issuer.origin, source: "manual" });
        expect([`oac_${keyedFirst.slice(7)}`, `oac_${keyedSecond.slice(7)}`]).toContain(
          client?.client.id,
        );
        expect(client?.access.audience.kind).toBe("everyone");
        for (const provider of [first.provider, second.provider])
          expect(
            yield* body(
              Options,
              yield* api.request(
                actors.owner,
                "GET",
                `${prefix}/providers/${provider}/oauth/oauth/setup`,
              ),
            ),
          ).toEqual({ issuer: issuer.origin, clients: [{ id: client?.client.id }] });
      }),
    ),
  );
});
