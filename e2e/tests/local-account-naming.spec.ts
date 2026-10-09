/** Local accounts are named after they connect, in a dialog over the page that follows. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import type { Page } from "playwright";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import {
  accountNameField,
  accountNamePrompt,
  nameAccountDialog,
  nameConnectedAccount,
} from "../support/name-account.ts";
import { Target } from "../support/platform.ts";
import { oauthRecoveryIssuer } from "../support/oauth-recovery-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Account = Schema.Struct({ id: Schema.String, label: Schema.String });
const Detail = Schema.Struct({ account: Account });
const Published = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const prompt = "Local naming fixture is connected. Choose a name you’ll recognize.";

layer(TestLive, { excludeTestServices: true })("Local account naming", (it) => {
  it.effect(scenarios.localPastedCredentialsNamedAfterSaving.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const browser = yield* Browser;
        const target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        // The agent API takes the host-issued bearer credential, not a browser origin.
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Local naming ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `
import { defineApp, defineProvider, secrets, object, string, router } from "apps";
const service = defineProvider({ name: "Local naming fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async () => ({ tools: router({}) }));
`,
              },
              appsManifest,
            ],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(Published, deployed);
        const provider = app.requirements.accounts.service.provider;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [`/v1/apps/${app.id}`, ...accounts.map((id) => `/v1/accounts/${id}`)],
            (path) =>
              session
                .send("DELETE", path, undefined, headers)
                .pipe(
                  Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
                ),
          ).pipe(Effect.orDie),
        );
        const savedLabel = (account: string) =>
          session.send("GET", `/dashboard/api/accounts/${account}`, undefined, headers).pipe(
            Effect.flatMap((response) => body(Detail, response)),
            Effect.map((detail) => detail.account.label),
          );
        // Account selection connects into an existing profile, as it does once an app is in use.
        const profile = yield* createProfile(
          agent,
          `/v1/apps/${app.id}`,
          { owner: "local", subject: "local" },
          headers,
        );
        // Every dashboard connection fills an app requirement.
        const add = (label?: string) =>
          Effect.gen(function* () {
            const account = yield* body(
              Account,
              yield* session.send(
                "POST",
                `/dashboard/api/apps/${app.id}/accounts`,
                {
                  profile: profile.id,
                  requirement: "service",
                  method: "key",
                  ...(label === undefined ? {} : { label }),
                  fields: { token: "synthetic-local-naming-token" },
                },
                headers,
              ),
            );
            accounts.push(account.id);
            return account.label;
          });
        expect(yield* add()).toBe("Default");
        expect(yield* add()).toBe("Default 2");
        expect(yield* add("Supplied name")).toBe("Supplied name");
        // Nothing connects or replaces credentials outside an app.
        for (const [method, path, payload] of [
          [
            "POST",
            "/dashboard/api/accounts",
            { provider, method: "key", fields: { token: "synthetic-local-naming-token" } },
          ],
          [
            "PUT",
            `/dashboard/api/accounts/${accounts[0]}/credentials`,
            { fields: { token: "synthetic-local-naming-token" } },
          ],
          ["POST", `/dashboard/api/accounts/${accounts[0]}/oauth/start`, {}],
          ["POST", "/dashboard/api/accounts/oauth/start", { provider, method: "key" }],
        ] as const)
          expect((yield* session.send(method, path, payload, headers)).status, path).toBe(404);
        expect(
          (yield* agent.send("POST", "/v1/account-connections", { owner: "local", provider }))
            .status,
        ).toBe(400);

        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("The paired inventory is visible", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Accounts offers no Add account", (page) =>
          page
            .goto("/accounts")
            .then(() => page.getByRole("heading", { name: "Accounts" }).first().waitFor())
            .then(() =>
              page.getByRole("button", { name: "Manage Supplied name", exact: true }).waitFor(),
            ),
        );
        expect(
          yield* browser.use("The Accounts page has no Add account action", (page) =>
            page.getByRole("link", { name: "Add account", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Add account is no longer a page", (page) =>
          page
            .goto("/accounts/add")
            .then(() =>
              page.getByRole("heading", { name: "Page not found", exact: true }).waitFor(),
            ),
        );
        expect(
          yield* browser.use("The credentials page is gone", (page) =>
            page
              .goto(`/accounts/${accounts[0]}/credentials`)
              .then((response) => response?.status()),
          ),
        ).toBe(404);

        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Connect a new account from the app's accounts", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const connect = yield* browser.use("The connection dialog opens", (page) => {
          const dialog = page.getByRole("dialog", {
            name: "Connect Local naming fixture",
            exact: true,
          });
          return dialog.waitFor({ state: "visible" }).then(() => dialog);
        });
        yield* browser.use("Enter the dialog's API key", () =>
          connect.getByLabel("Token", { exact: true }).fill("synthetic-local-naming-token"),
        );
        const dialogSubmitted = yield* browser.use("Add the account from the dialog", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === `/dashboard/api/apps/${app.id}/accounts`,
            ),
            connect.getByRole("button", { name: "Add account", exact: true }).click(),
          ]).then(([response]) => response.json() as Promise<unknown>),
        );
        const fromDialog = yield* Schema.decodeUnknownEffect(Account)(dialogSubmitted);
        accounts.push(fromDialog.id);
        expect(fromDialog.label).toBe("Default 3");
        yield* browser.use("The connection dialog closes and asks for a name", (page) =>
          connect
            .waitFor({ state: "hidden" })
            .then(() => accountNamePrompt(page))
            .then(() =>
              nameAccountDialog(page)
                .getByText(prompt, { exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        expect(
          yield* browser.use("The dialog's name starts as the saved default", (page) =>
            accountNameField(page).inputValue(),
          ),
        ).toBe("Default 3");
        yield* browser.checkpoint("Name the account over the app's accounts");
        yield* browser.use("Save the dialog account's name", (page) =>
          nameConnectedAccount(page, "Dialog key"),
        );
        // Saving a new account from the app chooses it in place.
        yield* browser.use("The app chooses the renamed account", (page) =>
          page.getByRole("radio", { name: "Dialog key", exact: true, checked: true }).waitFor(),
        );
        expect(yield* savedLabel(fromDialog.id)).toBe("Dialog key");
        yield* browser.checkpoint("Named account selected for the app");

        // Every account row keeps its menu in view, not only the selected one or on hover.
        expect(
          yield* browser.use("Unselected accounts show their menu without hover", (page) =>
            page.mouse
              .move(0, 0)
              .then(() =>
                page
                  .getByRole("button", { name: "Manage Supplied name", exact: true })
                  .evaluate((element) => getComputedStyle(element).opacity),
              ),
          ),
        ).toBe("1");
        expect(
          yield* browser.use("An unselected account's menu cannot remove it", (page) =>
            page
              .getByRole("button", { name: "Manage Supplied name", exact: true })
              .click()
              .then(() =>
                page.getByRole("menuitem", { name: "Edit details", exact: true }).waitFor(),
              )
              // Let the menu finish opening so the checkpoint shows it, not its fade-in.
              .then(() =>
                page
                  .getByRole("menu")
                  .evaluate((menu) =>
                    Promise.all(menu.getAnimations().map((animation) => animation.finished)),
                  ),
              )
              .then(() => page.getByRole("menuitem").allTextContents()),
          ),
        ).toEqual(["Edit details", "Update credentials"]);
        yield* browser.checkpoint("Unselected account menu");
        yield* browser.use("Close the unselected account's menu", (page) =>
          page.keyboard.press("Escape"),
        );

        // An unselected account's menu opens the same dialogs as a selected one.
        const edit = yield* browser.use("Edit an unselected account's details", (page) =>
          page
            .getByRole("button", { name: "Manage Supplied name", exact: true })
            .click()
            .then(() => page.getByRole("menuitem", { name: "Edit details", exact: true }).click())
            .then(() => page.getByRole("dialog", { name: "Edit account", exact: true }))
            .then((dialog) => dialog.waitFor({ state: "visible" }).then(() => dialog)),
        );
        yield* browser.checkpoint("Edit details from an unselected account");
        yield* browser.use("Cancel editing the details", () =>
          edit
            .getByRole("button", { name: "Cancel", exact: true })
            .click()
            .then(() => edit.waitFor({ state: "hidden" })),
        );
        const unselectedCredentials = yield* browser.use(
          "Update an unselected account's credentials",
          (page) =>
            page
              .getByRole("button", { name: "Manage Supplied name", exact: true })
              .click()
              .then(() =>
                page.getByRole("menuitem", { name: "Update credentials", exact: true }).click(),
              )
              .then(() => page.getByRole("dialog", { name: "Update credentials", exact: true }))
              .then((dialog) =>
                dialog
                  .getByLabel("Token", { exact: true })
                  .waitFor({ state: "visible" })
                  .then(() => dialog),
              ),
        );
        yield* browser.checkpoint("Update credentials from an unselected account");
        yield* browser.use("Close the credentials dialog", () =>
          unselectedCredentials
            .getByRole("button", { name: "Close", exact: true })
            .click()
            .then(() => unselectedCredentials.waitFor({ state: "hidden" })),
        );

        // Credentials are replaced from the app that selects the account, through its menu.
        yield* browser.use("Update the named account's credentials", (page) =>
          page
            .getByRole("button", { name: "Manage Dialog key", exact: true })
            .click()
            .then(() =>
              page.getByRole("menuitem", { name: "Update credentials", exact: true }).click(),
            ),
        );
        const replace = yield* browser.use("The credentials dialog opens", (page) => {
          const dialog = page.getByRole("dialog", { name: "Update credentials", exact: true });
          return dialog.waitFor({ state: "visible" }).then(() => dialog);
        });
        yield* browser.use("Enter a replacement API key", () =>
          replace.getByLabel("Token", { exact: true }).fill("synthetic-local-naming-token-2"),
        );
        const replaced = yield* browser.use("Save the replacement credentials", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === `/dashboard/api/apps/${app.id}/accounts`,
            ),
            replace.getByRole("button", { name: "Save credentials", exact: true }).click(),
          ]).then(([response]) => response.json() as Promise<unknown>),
        );
        expect((yield* Schema.decodeUnknownEffect(Account)(replaced)).id).toBe(fromDialog.id);
        yield* browser.use("The credentials dialog closes on the app", (page) =>
          replace
            .waitFor({ state: "hidden" })
            .then(() =>
              page.getByRole("radio", { name: "Dialog key", exact: true, checked: true }).waitFor(),
            ),
        );
        expect(
          yield* browser.use("Replacing credentials does not ask for a name", (page) =>
            nameAccountDialog(page).count(),
          ),
        ).toBe(0);
        expect(yield* savedLabel(fromDialog.id)).toBe("Dialog key");
        yield* browser.checkpoint("Replaced credentials keep the account on the app");
      }),
    ),
  );

  it.effect(scenarios.localOAuthNamedAfterReturn.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const target = yield* Target;
        const api = yield* Api;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const issuer = yield* oauthRecoveryIssuer(target.metadata.origin, true, "redirect");
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Local OAuth naming ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Sample service",auth:{oauth:oauth2({discover:${JSON.stringify(issuer.origin)},scopes:["reports:read"]})}});
export default defineApp({accounts:{service}},async()=>({tools:router({})}));`,
              },
              appsManifest,
            ],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(Published, deployed);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [`/v1/apps/${app.id}`, ...accounts.map((id) => `/v1/accounts/${id}`)],
            (path) => session.send("DELETE", path, undefined, headers),
          ).pipe(Effect.orDie),
        );
        const savedLabel = (account: string) =>
          session.send("GET", `/dashboard/api/accounts/${account}`, undefined, headers).pipe(
            Effect.flatMap((response) => body(Detail, response)),
            Effect.map((detail) => detail.account.label),
          );
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("The paired inventory is visible", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        const appPath = `/apps/${app.id}`;
        const completion = (page: Page) =>
          page
            .waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname === "/dashboard/api/accounts/oauth/complete",
            )
            .then((response) => response.json() as Promise<unknown>);
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`${appPath}?view=accounts`),
        );
        yield* browser.use("Connect a new account from the app", (page) =>
          page
            .getByRole("button", { name: "Connect new account", exact: true })
            .click()
            .then(() =>
              page.getByRole("button", { name: "Connect Sample service", exact: true }).click(),
            ),
        );
        const completed = yield* browser.use("Allow access", (page) =>
          Promise.all([
            completion(page),
            page.getByRole("button", { name: "Allow access", exact: true }).click(),
          ]).then(([json]) => json),
        );
        const account = (yield* Schema.decodeUnknownEffect(Account)(completed)).id;
        accounts.push(account);
        const returned = yield* browser.use("Return to the app to name the account", (page) =>
          page
            .waitForURL(
              (url) =>
                url.pathname === appPath &&
                url.searchParams.get("view") === "accounts" &&
                url.searchParams.has("profile"),
            )
            .then(() => accountNamePrompt(page))
            .then(() =>
              nameAccountDialog(page)
                .getByText("Sample service is connected. Choose a name you’ll recognize.", {
                  exact: true,
                })
                .waitFor({ state: "visible" }),
            )
            .then(() => accountNameField(page).inputValue()),
        );
        expect(returned).toBe("Default");
        yield* browser.checkpoint("Name a local OAuth account after sign-in returns");
        yield* browser.use("Name the OAuth account", (page) =>
          nameConnectedAccount(page, "Local reports"),
        );
        // Completing the app's connection selected the account; nothing binds it afterwards.
        yield* browser.use("The app selects the named account", (page) =>
          page.getByRole("radio", { name: "Local reports", exact: true, checked: true }).waitFor(),
        );
        expect(yield* savedLabel(account)).toBe("Local reports");

        yield* browser.use("Reconnect the named account from the app", (page) =>
          page
            .getByRole("button", { name: "Manage Local reports", exact: true })
            .click()
            .then(() => page.getByRole("menuitem", { name: "Reconnect", exact: true }).click())
            .then(() =>
              page.getByRole("button", { name: "Reconnect Sample service", exact: true }).click(),
            ),
        );
        const reconnected = yield* browser.use("Allow access again", (page) =>
          Promise.all([
            completion(page),
            page.getByRole("button", { name: "Allow access", exact: true }).click(),
          ]).then(([json]) => json),
        );
        expect((yield* Schema.decodeUnknownEffect(Account)(reconnected)).id).toBe(account);
        yield* browser.use("A reconnect returns to the app's accounts", (page) =>
          page
            .waitForURL(
              (url) => url.pathname === appPath && url.searchParams.get("view") === "accounts",
            )
            .then(() =>
              page
                .getByRole("radio", { name: "Local reports", exact: true, checked: true })
                .waitFor(),
            ),
        );
        expect(
          yield* browser.use("A reconnect does not ask for a name", (page) =>
            nameAccountDialog(page).count(),
          ),
        ).toBe(0);
        expect(yield* savedLabel(account)).toBe("Local reports");
        expect((yield* issuer.observations).filter((entry) => entry.tokenAccepted)).toHaveLength(2);
        yield* browser.checkpoint("Reconnected local OAuth account keeps its name");
      }),
    ),
  );
});
