import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { Evidence } from "../support/evidence.ts";
import { oauthRecoveryIssuer, recoveryClients } from "../support/oauth-recovery-issuer.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  accounts: Schema.Record(Schema.String, Schema.String),
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Setup = Schema.Struct({ mode: Schema.Literals(["automatic", "saved", "client-required"]) });
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("OAuth client recovery", (it) => {
  it.effect(scenarios.oauthClientRecovery.title, (context) =>
    withCase(
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
              content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service=defineProvider({name:"Recoverable OAuth",auth:{oauth:oauth2({authorizationUrl:${JSON.stringify(issuer.origin + "/authorize")},tokenUrl:${JSON.stringify(issuer.origin + "/token")},scopes:["read"],tokenEndpointAuthMethod:"client_secret_basic"})}});
export default defineApp({accounts:{service}},async()=>({queries:{}}));`,
            },
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
        let profile: string | undefined;
        const connection = () =>
          api
            .request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
              ...(profile === undefined ? {} : { profile }),
            })
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
        expect((yield* setup()).mode).toBe("client-required");
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
        yield* browser.use("Connect again", (page) =>
          page.getByRole("button", { name: "Connect Recoverable OAuth", exact: true }).click(),
        );
        yield* browser.use("Enter a rejected secret", (page) =>
          page
            .getByLabel("Client secret", { exact: true })
            .waitFor({ state: "visible" })
            .then(() => page.getByLabel("Account name", { exact: true }).fill("Recovery account"))
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
        expect((yield* setup()).mode).toBe("client-required");
        yield* browser.use("Reopen the client fields", (page) =>
          page.getByRole("link", { name: "Update client details", exact: true }).click(),
        );
        expect(
          yield* browser.use("Keep the account name across the callback", (page) =>
            page.getByLabel("Account name", { exact: true }).inputValue(),
          ),
        ).toBe("Recovery account");
        yield* browser.use("Correct the client and finish connecting", (page) =>
          page
            .getByLabel("Client ID", { exact: true })
            .fill(recoveryClients.original.clientId)
            .then(() =>
              page
                .getByLabel("Client secret", { exact: true })
                .fill(recoveryClients.original.clientSecret),
            )
            .then(() =>
              page.getByRole("button", { name: "Connect Recoverable OAuth", exact: true }).click(),
            )
            .then(() =>
              page
                .getByRole("link", { name: "Recovery account", exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        profile = yield* Schema.decodeUnknownEffect(Schema.String)(
          yield* browser.use("Read the selected account setup", (page) =>
            page.evaluate(() => new URL(location.href).searchParams.get("profile")),
          ),
        );
        const bindings = Schema.Struct({ accounts: Schema.Struct({ service: Schema.String }) });
        savedAccount = (yield* body(
          bindings,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/profiles/${profile}`),
        )).accounts.service;
        expect(savedAccount).toBeDefined();
        expect((yield* setup()).mode).toBe("saved");
        const reconnect = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/accounts/${savedAccount}/connections`,
          ),
        );
        yield* browser.use("Open the existing account for reconnection", (page) =>
          page.goto(`/org/${actors.organization.slug}/connections/${reconnect.id}`),
        );
        yield* browser.use("Saved clients can be changed", (page) =>
          page.getByRole("button", { name: "Change OAuth client", exact: true }).click(),
        );
        yield* browser.checkpoint("Saved OAuth client can be replaced");
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
        const retained = yield* connection();
        const retainedStart = yield* body(
          Redirect,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${retained.id}/oauth/start`,
            { method: "oauth", label: "Inspect retained client" },
          ),
        );
        expect(new URL(retainedStart.authorizationUrl).searchParams.get("client_id")).toBe(
          recoveryClients.original.clientId,
        );
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
              page.getByRole("heading", { name: /Recovery account/ }).waitFor({ state: "visible" }),
            ),
        );
        expect(
          (yield* body(
            bindings,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/profiles/${profile}`),
          )).accounts.service,
        ).toBe(savedAccount);
        const replacement = yield* connection();
        const replacementStart = yield* body(
          Redirect,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${replacement.id}/oauth/start`,
            { method: "oauth", label: "Inspect replacement client" },
          ),
        );
        expect(new URL(replacementStart.authorizationUrl).searchParams.get("client_id")).toBe(
          recoveryClients.replacement.clientId,
        );
        yield* browser.checkpoint("Replacement succeeded without changing the account");
      }),
    ),
  );
});
