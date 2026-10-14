/**
 * Versions before 4.0.10 saved OAuth clients under a digest of their owner, provider, method,
 * callback, issuer and scopes. `6_stored_oauth_clients` moves each to the one owner and provider
 * whose accounts signed in with it, and reports a client that accounts of several providers hold as
 * `ambiguous_owner`, filed under why: how many owners and providers hold it, whether it has a
 * secret, how it was saved, and whether exactly one holder's settings reproduce its key. The
 * product starts with data steps held in report mode, so each start reports the step again.
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

const step = "6_stored_oauth_clients";
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
      name: "saved-client-fixture",
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
const Registered = Schema.Struct({ client: Schema.Struct({ id: Schema.String }) });
const Holder = Schema.Struct({
  owner: Schema.String,
  provider: Schema.String,
  method: Schema.String,
});

layer(TestLive, { excludeTestServices: true })("Ambiguous saved OAuth clients", (it) => {
  it.effect(scenarios.savedOAuthClientsAmbiguous.title, (context) =>
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

        // Registered once for the service's server, which both apps sign in at.
        const client = yield* body(
          Registered,
          yield* api.request(actors.owner, "POST", `${prefix}/oauth-clients`, {
            issuer: issuer.origin,
            ...entered,
          }),
        );

        /** Deploy an app of its own provider and sign in to it with the registered client. */
        const connect = (name: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files: appFiles(name, `${issuer.origin}/mcp`),
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(DeployedApp, deployed);
            yield* Effect.addFinalizer(() =>
              serverControl("start").pipe(
                Effect.andThen(api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)),
                Effect.orDie,
              ),
            );
            const provider = app.requirements.accounts.service.provider;
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
                client: { id: client.client.id },
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
            return { provider, redirectUri: redirect.redirectUri };
          });

        const first = yield* connect(`Saved client A ${randomUUID().slice(0, 8)}`);
        const second = yield* connect(`Saved client B ${randomUUID().slice(0, 8)}`);
        const providers = [first.provider, second.provider].sort();

        const [holders = []] = yield* legacyStorage([
          {
            sql: `SELECT owner, provider, method FROM executor_accounts
              WHERE provider = ANY($1::text[]) ORDER BY provider`,
            params: [`{${providers.join(",")}}`],
          },
        ]);
        const holder = Schema.decodeUnknownSync(Schema.Array(Holder))(holders).find(
          (row) => row.provider === first.provider,
        );
        if (holder === undefined) return yield* Effect.die("The first service has no account");
        // The key an older version gave the client the first service's sign-in saved.
        const keyed = `client_${createHash("sha256")
          .update(
            JSON.stringify([
              holder.owner,
              holder.provider,
              holder.method,
              new URL(first.redirectUri).href,
              issuer.origin,
              null,
              [...scopes].sort(),
            ]),
          )
          .digest("hex")}`;
        // A key no holder's settings reproduce, saved before sources were recorded.
        const unkeyed = `client_${randomBytes(32).toString("hex")}`;
        const registration = {
          client_id: entered.clientId,
          client_secret: entered.clientSecret,
          token_endpoint_auth_method: "client_secret_basic",
        };
        const seen = (yield* dataStepSummaries(log, step)).length;
        yield* legacyStorage([
          {
            sql: `INSERT INTO executor_oauth_clients (id, encrypted) VALUES ($1, $2), ($3, $4)`,
            params: [
              keyed,
              {
                sealed: {
                  id: keyed,
                  value: { ...registration, executor_source: "manual" },
                },
              },
              unkeyed,
              { sealed: { id: unkeyed, value: registration } },
            ],
          },
        ]);
        yield* serverControl("start");

        const bucket = (source: string, resolvable: string) =>
          [
            "ambiguous:owners=1",
            "providers=2",
            "secret=yes",
            `source=${source}`,
            `resolvable_by_key=${resolvable}`,
            `provider_ids=${providers.join("|")}`,
          ].join(",");
        const report = yield* nextDataStepSummary(log, step, seen);
        expect(report).toMatchObject({
          mode: "report",
          status: "complete",
          outcomes: { ambiguous_owner: 2 },
        });
        expect(report.owners).toEqual({
          [bucket("manual", "yes")]: { ambiguous_owner: 1 },
          [bucket("unrecorded", "no")]: { ambiguous_owner: 1 },
        });
      }),
    ),
  );
});
