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
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { enterClientDetails } from "../support/oauth-client-entry.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Setup = Schema.Struct({
  mode: Schema.Literals(["automatic", "client-required"]),
  clients: Schema.Array(Schema.Struct({ id: Schema.String })),
});
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("OAuth client recovery", (it) => {
  it.effect(scenarios.oauthClientRecovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const issuer = yield* oauthRecoveryIssuer(target.metadata.origin);
        const evidence = yield* Evidence;
        const submissions: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* evidence.json("recovery-protocol.json", {
              submissions,
              tokens: yield* issuer.observations,
            });
          }),
        );
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `OAuth recovery ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Recoverable OAuth",auth:{oauth:oauth2({authorizationUrl:${JSON.stringify(issuer.origin + "/authorize")},tokenUrl:${JSON.stringify(issuer.origin + "/token")},scopes:["read"],tokenEndpointAuthMethod:"client_secret_basic"})}});
export default defineApp({user: { accounts:{service} }},async()=>({tools: router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        let savedAccount: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            if (savedAccount !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${savedAccount}`);
          }).pipe(Effect.orDie),
        );
        const setup = () =>
          api
            .request(
              actors.owner,
              "GET",
              `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
            )
            .pipe(Effect.flatMap((response) => body(Setup, response)));
        const connection = () =>
          api
            .request(
              actors.owner,
              "POST",
              connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
              {},
            )
            .pipe(Effect.flatMap((response) => body(Resource, response)));
        const started = yield* connection();
        const bad = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${started.id}/oauth/start`,
          {
            method: "oauth",
            label: "Unverified",
            client: { clientId: "bad-client", clientSecret: "bad-secret" },
          },
        );
        expect(bad.status).toBe(200);
        yield* issuer.registerCallback((yield* body(Redirect, bad)).redirectUri);
        expect(yield* setup()).toEqual({ mode: "client-required", clients: [] });
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Observe credential replacement without recording values", (page) =>
          page.route(/\/connections\/[^/]+\/oauth\/start$/, (route) => {
            const submitted: unknown = route.request().postDataJSON();
            const input = Schema.decodeUnknownSync(
              Schema.Struct({
                client: Schema.optional(
                  Schema.Struct({ clientSecret: Schema.optional(Schema.String) }),
                ),
              }),
            )(submitted);
            const secret = input.client?.clientSecret;
            submissions.push(
              secret === recoveryClients.original.clientSecret
                ? "original"
                : secret === recoveryClients.replacement.clientSecret
                  ? "replacement"
                  : secret === "wrong-secret"
                    ? "rejected"
                    : "none",
            );
            return route.continue();
          }),
        );
        yield* browser.use("Open a fresh client form after a bad attempt", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Choose an account for the app", (page) =>
          page
            .getByRole("button", { name: "Connect new account", exact: true })
            .click()
            .then(() => enterClientDetails(page)),
        );
        yield* issuer.configure({ tokenFails: true });
        yield* browser.use("Enter a valid client while the service is unavailable", (page) =>
          page
            .getByLabel("Client secret", { exact: true })
            .waitFor({ state: "visible" })
            .then(() =>
              page.getByLabel("Client ID", { exact: true }).fill(recoveryClients.original.clientId),
            )
            .then(() =>
              page
                .getByLabel("Client secret", { exact: true })
                .fill(recoveryClients.original.clientSecret),
            )
            .then(() =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: "Connect Recoverable OAuth", exact: true })
                .click(),
            ),
        );
        yield* browser.use("A failure unrelated to the client offers a plain retry", (page) =>
          page.getByRole("link", { name: "Try again", exact: true }).waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Do not suggest changing a client the service accepted", (page) =>
            page.getByRole("link", { name: "Update client details", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Unavailable service callback");
        yield* issuer.configure({ tokenFails: false });
        yield* browser.use("Retry reopens the unsaved client fields", (page) =>
          page.getByRole("link", { name: "Try again", exact: true }).click(),
        );
        yield* browser.use("Enter a rejected secret", (page) =>
          page
            .getByLabel("Client secret", { exact: true })
            .waitFor({ state: "visible" })
            .then(() =>
              page.getByLabel("Client ID", { exact: true }).fill(recoveryClients.original.clientId),
            )
            .then(() => page.getByLabel("Client secret", { exact: true }).fill("wrong-secret"))
            .then(() =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: "Connect Recoverable OAuth", exact: true })
                .click(),
            ),
        );
        yield* browser.use("A rejected client has a direct recovery action", (page) =>
          page
            .getByRole("link", { name: "Update client details", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(yield* setup()).toEqual({ mode: "client-required", clients: [] });
        yield* browser.use("Reopen the client fields", (page) =>
          page.getByRole("link", { name: "Update client details", exact: true }).click(),
        );
        // Pasted secrets often carry surrounding whitespace; the issuer compares secrets exactly.
        yield* browser.use("Correct the client and finish connecting", (page) =>
          page
            .getByLabel("Client ID", { exact: true })
            .fill(recoveryClients.original.clientId)
            .then(() =>
              page
                .getByLabel("Client secret", { exact: true })
                .fill(` ${recoveryClients.original.clientSecret} `),
            )
            .then(() =>
              page.getByRole("button", { name: "Connect Recoverable OAuth", exact: true }).click(),
            )
            .then(() => nameConnectedAccount(page, "Recovery account"))
            .then(() =>
              linkedChoice(page, "Recoverable OAuth", "Recovery account").waitFor({
                state: "visible",
              }),
            ),
        );
        // Connecting from the app linked the new account to it.
        const linked = yield* linkedAccountIds(actors.owner, `${prefix}/apps/${app.id}`);
        expect(linked).toHaveLength(1);
        savedAccount = linked[0];
        expect(savedAccount).toBeDefined();
        // A client entered for one account signs in that account only; nobody else is offered it.
        expect(yield* setup()).toEqual({ mode: "client-required", clients: [] });
        // A reconnect without a client choice keeps the client the account's grant holds.
        const reconnectStart = () =>
          Effect.gen(function* () {
            const started = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
                {
                  account: savedAccount,
                },
              ),
            );
            const signIn = yield* body(
              Redirect,
              yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${started.id}/oauth/start`,
                { method: "oauth" },
              ),
            );
            return new URL(signIn.authorizationUrl).searchParams.get("client_id");
          });
        const reconnect = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
            {
              account: savedAccount,
            },
          ),
        );
        yield* browser.use("Open the existing account for reconnection", (page) =>
          page.goto(`/org/${actors.organization.slug}/connections/${reconnect.id}`),
        );
        // The account's own client is the only one to sign in with, so it is used without a
        // choice; replacing it stays under Advanced.
        expect(
          yield* browser.use("A reconnect with one client offers no choice", (page) =>
            page
              .getByRole("button", { name: "Reconnect Recoverable OAuth", exact: true })
              .waitFor({ state: "visible" })
              .then(() => page.getByRole("combobox", { name: "OAuth client" }).count()),
          ),
        ).toBe(0);
        yield* browser.use("A reconnect keeps its account's client by default", (page) =>
          page
            .getByText("Advanced", { exact: true })
            .click()
            .then(() =>
              page
                .getByRole("combobox", { name: "OAuth client" })
                .filter({ hasText: "Current client" })
                .waitFor({ state: "visible" }),
            ),
        );
        yield* browser.checkpoint("Reconnect OAuth client options");
        yield* browser.use("The account's client can be replaced", (page) =>
          page
            .getByRole("combobox", { name: "OAuth client" })
            .click()
            .then(() =>
              page.getByRole("option", { name: "Enter client details", exact: true }).click(),
            ),
        );
        yield* browser.checkpoint("Account client can be replaced");
        yield* browser.use("Try an invalid replacement", (page) =>
          page
            .getByLabel("Client ID", { exact: true })
            .fill(recoveryClients.replacement.clientId)
            .then(() => page.getByLabel("Client secret", { exact: true }).fill("wrong-secret"))
            .then(() =>
              page
                .getByRole("button", { name: "Reconnect Recoverable OAuth", exact: true })
                .click(),
            )
            .then(() =>
              page
                .getByRole("link", { name: "Update client details", exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        // The rejected replacement never reached the account's grant.
        expect(yield* reconnectStart()).toBe(recoveryClients.original.clientId);
        yield* browser.use("Correct the replacement client", (page) =>
          page
            .getByRole("link", { name: "Update client details", exact: true })
            .click()
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
            .then(() =>
              page
                .getByRole("button", { name: "Reconnect Recoverable OAuth", exact: true })
                .click(),
            )
            .then(() =>
              page
                // A reconnect through the app returns to that app's accounts.
                .waitForURL(
                  (url) =>
                    url.pathname === `/org/${actors.organization.slug}/apps/${app.id}` &&
                    url.searchParams.get("view") === "accounts",
                )
                .then(() =>
                  page
                    .getByRole("button", { name: /^Manage Recovery account/ })
                    .waitFor({ state: "visible" }),
                ),
            ),
        );
        // Reconnecting with a replacement client keeps the same account linked.
        expect(yield* linkedAccountIds(actors.owner, `${prefix}/apps/${app.id}`)).toEqual([
          savedAccount,
        ]);
        expect(yield* reconnectStart()).toBe(recoveryClients.replacement.clientId);
        yield* browser.checkpoint("Replacement succeeded without changing the account");
      }),
    ),
  );
});
