import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { accountIdentityIssuer } from "../support/account-identity-issuer.ts";
import { accountIdentityProduct, IdentityAccount } from "../support/account-identity-product.ts";
import { Browser } from "../support/browser.ts";
import { body } from "../support/api.ts";
import { dismissAccountName } from "../support/name-account.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Account identity screens", (it) => {
  it.effect(scenarios.googleIdentityRecipe.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const product = yield* accountIdentityProduct,
          target = yield* Target;
        const scopes = [
          "https://mail.google.com/",
          "https://www.googleapis.com/auth/gmail.settings.basic",
        ];
        const config = {
          identity: undefined,
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          authorizationParams: { access_type: "offline", prompt: "consent" },
        };
        const app = yield* product.deploy(
          "https://accounts.google.com",
          "Google catalog recipe",
          scopes,
          config,
        );
        const productResponse = (connection: string) =>
          product.request("GET", `/v1/account-connections/${connection}`);
        const connection = yield* product.connection(app);
        const first = yield* body(
          Schema.Struct({
            provider: Schema.Struct({
              id: Schema.String,
              definition: Schema.Struct({
                auth: Schema.Struct({
                  oauth: Schema.Struct({
                    scopes: Schema.Array(Schema.String),
                    identity: Schema.optionalKey(
                      Schema.Struct({ issuer: Schema.String, name: Schema.String }),
                    ),
                  }),
                }),
              }),
            }),
          }),
          yield* productResponse(connection),
        );
        expect(first.provider.definition.auth.oauth.identity).toEqual({
          issuer: "https://accounts.google.com",
          name: "Google",
        });
        expect(first.provider.definition.auth.oauth.scopes).toEqual(scopes);
        const started = yield* product.request("POST", "/v1/account-connections/oauth/start", {
          connection,
          method: "oauth",
          redirectUri: target.metadata.origin + "/api/oauth/callback",
          client: { clientId: "example-client" },
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const redirect = new URL(
          (yield* body(Schema.Struct({ authorizationUrl: Schema.String }), started))
            .authorizationUrl,
        );
        expect(redirect.searchParams.get("scope")?.split(" ")).toEqual([
          ...scopes,
          "openid",
          "email",
        ]);
        expect(redirect.searchParams.get("include_granted_scopes")).toBe("true");
        expect(redirect.searchParams.get("access_type")).toBe("offline");
        expect(redirect.searchParams.get("prompt")).toBe("consent");
        yield* product.deploy(
          "https://accounts.google.com",
          "Google catalog recipe",
          scopes,
          { ...config, identity: { issuer: "https://accounts.google.com", name: "Google" } },
          app,
        );
        const again = yield* body(
          Schema.Struct({ provider: Schema.Struct({ id: Schema.String }) }),
          yield* productResponse(yield* product.connection(app)),
        );
        expect(again.provider.id).toBe(first.provider.id);
        const spoof = yield* product.deploy("https://example.test", "Google", ["read"], {
          identity: undefined,
        });
        const untrusted = yield* body(
          Schema.Struct({
            provider: Schema.Struct({
              definition: Schema.Struct({
                auth: Schema.Struct({
                  oauth: Schema.Struct({ identity: Schema.optionalKey(Schema.Unknown) }),
                }),
              }),
            }),
          }),
          yield* productResponse(yield* product.connection(spoof)),
        );
        expect(untrusted.provider.definition.auth.oauth.identity).toBeUndefined();
      }),
    ),
  );

  it.effect(scenarios.accountIdentityRows.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* accountIdentityIssuer,
          product = yield* accountIdentityProduct,
          browser = yield* Browser;
        const retained: { app: string; account: string }[] = [];
        for (let index = 0; index < 5; index++) {
          const app = yield* product.deploy(
            issuer.origin,
            `Connected app ${index + 1}`,
            index === 0 ? ["read", "write"] : ["read"],
          );
          const account = yield* product.connect(app);
          retained.push({ app, account: account.id });
        }
        const later = yield* product.deploy(issuer.origin, "Later app", ["write"]);
        const paired = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* product.request("POST", "/auth/pair"),
        );
        yield* browser.use("Pair the local browser", (page) => page.goto(paired.url));
        yield* browser.use("Open the Accounts inventory", (page) =>
          page
            .goto("/accounts")
            .then(() => page.getByRole("heading", { name: /^Accounts/ }).waitFor())
            .then(() =>
              page
                .locator(".inventory-row")
                .filter({ hasText: "same@example.test" })
                .first()
                .waitFor(),
            ),
        );
        expect(
          yield* browser.use("Five app bindings occupy one verified row", (page) =>
            page.locator(".inventory-row").filter({ hasText: "same@example.test" }).count(),
          ),
        ).toBe(1);
        for (let index = 0; index < 5; index++)
          yield* browser.use("Each retained app remains linked", (page) =>
            page
              .locator(".inventory-row")
              .filter({ hasText: "same@example.test" })
              .getByRole("link", { name: `Connected app ${index + 1}` })
              .waitFor(),
          );
        yield* browser.checkpoint("One verified account with five app links");
        yield* browser.use("Add a later app from the saved account", (page) =>
          page.getByRole("button", { name: "Add Fixture identity app", exact: true }).click(),
        );
        yield* browser.use("Choose the later app", (page) =>
          page
            .getByRole("combobox", { name: "App", exact: true })
            .click()
            .then(() => page.getByRole("option", { name: "Later app", exact: true }).click()),
        );
        yield* browser.use("The existing grant covers the app", (page) =>
          page.getByRole("button", { name: "Add app", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("A covering sign-in needs no provider consent");
        yield* browser.use("Connect the covered app", (page) =>
          page
            .getByRole("button", { name: "Add app", exact: true })
            .click()
            .then(() => dismissAccountName(page)),
        );
        yield* browser.use("The added app appears on the same identity row", (page) =>
          page
            .locator(".inventory-row")
            .filter({ hasText: "same@example.test" })
            .getByRole("link", { name: "Later app" })
            .waitFor(),
        );
        expect((yield* issuer.metrics).authorizations).toBe(5);
        expect((yield* product.read(later)).status).toBe(200);
        for (const retainedBinding of retained) {
          expect((yield* product.read(retainedBinding.app)).status).toBe(200);
          expect(
            (yield* body(
              IdentityAccount,
              yield* product.request("GET", `/v1/accounts/${retainedBinding.account}`),
            )).id,
          ).toBe(retainedBinding.account);
        }
        yield* browser.use("Inspect each binding's independent actions", (page) =>
          page.getByRole("button", { name: "Manage apps", exact: true }).click(),
        );
        yield* browser.checkpoint("Every binding remains independently manageable");
        yield* browser.use("Close binding actions and inspect the phone layout", (page) =>
          page.keyboard
            .press("Escape")
            .then(() => page.setViewportSize({ width: 390, height: 844 })),
        );
        expect(
          yield* browser.use("The phone layout does not overflow", (page) =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("The identity label stays readable on a phone", (page) =>
            page
              .locator(".inventory-row")
              .filter({ hasText: "same@example.test" })
              .locator("strong")
              .first()
              .evaluate((element) => {
                const range = document.createRange();
                range.selectNodeContents(element);
                return range.getClientRects().length;
              }),
          ),
        ).toBeLessThanOrEqual(2);
        yield* browser.checkpoint("Grouped accounts at phone width");
      }),
    ),
  );

  it.effect(scenarios.accountIdentityConsentScreen.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* accountIdentityIssuer,
          product = yield* accountIdentityProduct,
          browser = yield* Browser;
        const existing = yield* product.deploy(issuer.origin, "Existing reader", ["read"]);
        const source = yield* product.connect(existing, "own-client");
        const writer = yield* product.deploy(issuer.origin, "Writer", ["write"]);
        const organizer = yield* product.deploy(issuer.origin, "Organizer", ["organize"]);
        const paired = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* product.request("POST", "/auth/pair"),
        );
        yield* browser.use("Pair the local browser", (page) => page.goto(paired.url));
        yield* browser.use("Open the existing identity", (page) =>
          page
            .goto("/accounts")
            .then(() =>
              page.getByRole("button", { name: "Add Fixture identity app", exact: true }).waitFor(),
            ),
        );
        yield* browser.use("Connect Writer", (page) =>
          page
            .getByRole("button", { name: "Add Fixture identity app", exact: true })
            .click()
            .then(() => page.getByRole("combobox", { name: "App", exact: true }).click())
            .then(() => page.getByRole("option", { name: "Writer", exact: true }).click()),
        );
        yield* browser.use("Keep the own-client sign-in route available", (page) =>
          page
            .getByRole("combobox", { name: "Fixture identity account", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("option", { name: "Use another Fixture identity account", exact: true })
                .click(),
            ),
        );
        yield* browser.use("The original OAuth client form is still available", (page) =>
          page.getByRole("textbox", { name: "Client ID", exact: true }).waitFor(),
        );
        yield* browser.use("Select the retained identity again", (page) =>
          page
            .getByRole("combobox", { name: "Fixture identity account", exact: true })
            .click()
            .then(() =>
              page.getByRole("option", { name: "same@example.test", exact: true }).click(),
            ),
        );
        yield* browser.use("Include Organizer in the same consent", (page) =>
          page.getByRole("checkbox", { name: "Organizer", exact: true }).check(),
        );
        yield* browser.use("Additional permissions need one consent", (page) =>
          page
            .getByRole("button", { name: "Continue with Fixture identity", exact: true })
            .waitFor(),
        );
        yield* browser.checkpoint(
          "One selected identity and two apps waiting for additional access",
        );
        yield* browser.use("Approve the additional app access", (page) =>
          page
            .getByRole("button", { name: "Continue with Fixture identity", exact: true })
            .click()
            .then(() => dismissAccountName(page)),
        );
        yield* browser.use("Return to Accounts", (page) =>
          page
            .goto("/accounts")
            .then(() => page.getByRole("heading", { name: /^Accounts/ }).waitFor())
            .then(() =>
              page
                .locator(".inventory-row")
                .filter({ hasText: "same@example.test" })
                .first()
                .waitFor(),
            ),
        );
        expect(
          yield* browser.use("The consent expands the same row", (page) =>
            page.locator(".inventory-row").filter({ hasText: "same@example.test" }).count(),
          ),
        ).toBe(1);
        for (const app of [existing, writer, organizer])
          expect((yield* product.read(app)).status).toBe(200);
        expect((yield* issuer.metrics).authorizations).toBe(2);
        expect(
          (yield* body(IdentityAccount, yield* product.request("GET", `/v1/accounts/${source.id}`)))
            .identity?.id,
        ).toBe(source.identity?.id);
        yield* browser.checkpoint("The same verified identity now serves all three apps");
      }),
    ),
  );
});
