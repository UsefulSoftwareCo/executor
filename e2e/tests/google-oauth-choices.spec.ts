/** Google-labelled services keep BYO visible without changing a new or saved account's client. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";
import { oauthRecoveryIssuer, recoveryClients } from "../support/oauth-recovery-issuer.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { linkedAccountIds, connectionsPath } from "../support/app-accounts.ts";
import { linkedChoice } from "../support/account-choices.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ id: Schema.String });
const Registered = Schema.Struct({ client: Schema.Struct({ id: Schema.String }) });
const Redirect = Schema.Struct({ authorizationUrl: Schema.String, redirectUri: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Google OAuth choices", (it) => {
  it.effect(scenarios.googleOAuthChoices.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target,
          evidence = yield* Evidence;
        const issuer = yield* oauthRecoveryIssuer(target.metadata.origin);
        const prefix = `/api/organizations/${actors.organization.id}`;
        const registered = yield* body(
          Registered,
          yield* api.request(actors.owner, "POST", `${prefix}/oauth-clients`, {
            issuer: `${issuer.origin}/token`,
            ...recoveryClients.original,
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/oauth-clients/${registered.client.id}`)
            .pipe(Effect.orDie),
        );
        const deploy = (name: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} choices ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: {
  oauth: oauth2({ authorizationUrl: ${JSON.stringify(issuer.origin + "/authorize")}, tokenUrl: ${JSON.stringify(issuer.origin + "/token")}, scopes: ["read"], tokenEndpointAuthMethod: "client_secret_basic" }),
} });
export default defineApp({ user: { accounts: { service: service.many() } } }, { tools: router({}) });`,
                },
                appsManifest,
              ],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            const path = `${prefix}/apps/${app.id}`;
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
            );
            const connection = (account?: string) =>
              api
                .request(actors.owner, "POST", connectionsPath(path, "user", "service"), {
                  ...(account === undefined ? {} : { account }),
                })
                .pipe(Effect.flatMap((answer) => body(Resource, answer)));
            return { path, id: app.id, connection };
          });
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        const providerNames = [
          "Google",
          "Google Calendar",
          "Google Drive",
          "Google Docs",
          "Google Sheets",
          "Google Photos",
          "Google Admin",
          "Gmail",
        ];
        let gmail: Effect.Success<ReturnType<typeof deploy>> | undefined;
        let gmailConnection: string | undefined;
        for (const name of providerNames) {
          const app = yield* deploy(name);
          const connection = yield* app.connection();
          const started = yield* body(
            Redirect,
            yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "oauth", client: { id: registered.client.id } },
            ),
          );
          expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(
            recoveryClients.original.clientId,
          );
          yield* issuer.registerCallback(started.redirectUri);
          yield* browser.use(`Open a fresh ${name} connection`, (page) =>
            page.goto(`/org/${actors.organization.slug}/connections/${connection.id}`),
          );
          yield* browser.use(
            `${name} keeps the registered client selected and exposes Google BYO`,
            (page) => {
              const clients = page.getByRole("combobox", { name: "OAuth client", exact: true });
              return clients
                .filter({ hasText: recoveryClients.original.clientId })
                .waitFor({ state: "visible" })
                .then(() => clients.click())
                .then(() =>
                  page
                    .getByRole("option", { name: "Your own Google app (OAuth)", exact: true })
                    .waitFor({ state: "visible" }),
                )
                .then(() => page.keyboard.press("Escape"));
            },
          );
          yield* browser.checkpoint(`${name} fresh client choices`);
          if (name === "Gmail") {
            gmail = app;
            gmailConnection = connection.id;
          }
        }
        if (gmail === undefined || gmailConnection === undefined)
          return yield* Effect.die("The Gmail fixture was not deployed");
        const selected = gmail;
        yield* browser.use("Connect Gmail with the selected registered client", (page) =>
          page
            .getByRole("button", { name: "Connect Gmail", exact: true })
            .click()
            .then(() => nameConnectedAccount(page, "Shared Gmail")),
        );
        yield* browser.use("The first Gmail account is linked to the app", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/${selected.id}?view=accounts`)
            .then(() => linkedChoice(page, "Gmail", "Shared Gmail").waitFor({ state: "visible" })),
        );
        const firstLinks = yield* linkedAccountIds(actors.owner, selected.path);
        expect(firstLinks).toHaveLength(1);
        const first = firstLinks[0]!;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/accounts/${first}`).pipe(Effect.orDie),
        );
        const secondConnection = yield* selected.connection();
        yield* browser.use("Open another Gmail account", (page) =>
          page.goto(`/org/${actors.organization.slug}/connections/${secondConnection.id}`),
        );
        yield* browser.use(
          "Choose personal credentials for only the second Gmail account",
          (page) =>
            page
              .getByRole("combobox", { name: "OAuth client", exact: true })
              .click()
              .then(() =>
                page
                  .getByRole("option", { name: "Your own Google app (OAuth)", exact: true })
                  .click(),
              )
              .then(() =>
                page
                  .getByLabel("Client ID", { exact: true })
                  .fill(recoveryClients.replacement.clientId),
              )
              .then(() =>
                page
                  .getByLabel("Client secret", { exact: true })
                  .fill(recoveryClients.replacement.clientSecret),
              )
              .then(() => page.getByRole("button", { name: "Connect Gmail", exact: true }).click())
              .then(() => nameConnectedAccount(page, "Personal Gmail")),
        );
        yield* browser.use("Both Gmail accounts stay linked to the app", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/${selected.id}?view=accounts`)
            .then(() => linkedChoice(page, "Gmail", "Personal Gmail").waitFor({ state: "visible" }))
            .then(() => linkedChoice(page, "Gmail", "Shared Gmail").waitFor({ state: "visible" })),
        );
        const linked = yield* linkedAccountIds(actors.owner, selected.path);
        expect(linked).toHaveLength(2);
        expect(linked).toContain(first);
        const second = linked.find((id) => id !== first)!;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/accounts/${second}`).pipe(Effect.orDie),
        );
        const accountClients = [
          [first, recoveryClients.original.clientId],
          [second, recoveryClients.replacement.clientId],
        ] as const;
        for (const [account, clientId] of accountClients) {
          const reconnect = yield* selected.connection(account);
          yield* browser.use("A Gmail reconnect keeps its own client selected", (page) =>
            page
              .goto(`/org/${actors.organization.slug}/connections/${reconnect.id}`)
              .then(() =>
                page
                  .getByRole("combobox", { name: "OAuth client", exact: true })
                  .filter({ hasText: "Current client" })
                  .waitFor({ state: "visible" }),
              ),
          );
          const redirect = yield* body(
            Redirect,
            yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${reconnect.id}/oauth/start`,
              { method: "oauth" },
            ),
          );
          expect(new URL(redirect.authorizationUrl).searchParams.get("client_id")).toBe(clientId);
        }
        const tokens = yield* issuer.observations;
        expect(tokens.filter((entry) => entry.tokenAccepted && entry.original)).toHaveLength(1);
        expect(tokens.filter((entry) => entry.tokenAccepted && entry.replacement)).toHaveLength(1);
        yield* evidence.json("google-client-choices.json", { providerNames, tokens });
        yield* browser.checkpoint("Two Gmail accounts retain separate OAuth clients");
      }),
    ),
  );
});
