/** Accounts with pasted credentials are named after they are saved, in a dialog over the app. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import {
  accountNameField,
  accountNamePrompt,
  nameAccountDialog,
  nameConnectedAccount,
} from "../support/name-account.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Account = Schema.Struct({ id: Schema.String, label: Schema.String });
const Detail = Schema.Struct({ account: Account });

layer(HostedLive, { excludeTestServices: true })("Account naming", (it) => {
  it.effect(scenarios.pastedCredentialsNamedAfterSaving.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Naming ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({ name: "Naming fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async () => ({ tools: router({}) }));
`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)).status,
            ).toBe(200);
            for (const account of accounts)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`))
                  .status,
              ).toBe(200);
          }).pipe(Effect.orDie),
        );
        const savedLabel = (account: string) =>
          api.request(actors.owner, "GET", `${prefix}/accounts/${account}`).pipe(
            Effect.flatMap((response) => body(Detail, response)),
            Effect.map((detail) => detail.account.label),
          );

        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Connect a new account from the list", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const connect = yield* browser.use("The connection dialog opens", (page) => {
          const dialog = page.getByRole("dialog", { name: "Connect Naming fixture", exact: true });
          return dialog.waitFor({ state: "visible" }).then(() => dialog);
        });
        expect(
          yield* browser.use("The credential form does not ask for a name", () =>
            connect.getByRole("textbox", { name: "Account name" }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Enter the synthetic API key", () =>
          connect.getByLabel("Token", { exact: true }).fill("synthetic-naming-token"),
        );
        const submitted = yield* browser.use("Save the credentials", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname.endsWith("/submit"),
            ),
            connect.getByRole("button", { name: "Connect account", exact: true }).click(),
          ]).then(([response]) => response.json() as Promise<unknown>),
        );
        const created = yield* Schema.decodeUnknownEffect(Account)(submitted);
        accounts.push(created.id);
        expect(created.label).toBe("Default");
        const prompt = yield* browser.use(
          "Saving closes the connection dialog and asks for a name",
          (page) =>
            connect
              .waitFor({ state: "hidden" })
              .then(() => accountNamePrompt(page))
              .then(() =>
                nameAccountDialog(page)
                  .getByText("Naming fixture is connected. Choose a name you’ll recognize.", {
                    exact: true,
                  })
                  .waitFor({ state: "visible" }),
              )
              .then(() => accountNameField(page).inputValue())
              .then((name) => ({ name, url: new URL(page.url()) })),
        );
        expect(prompt.name).toBe("Default");
        expect(prompt.url.pathname).toBe(`/org/${actors.organization.slug}/apps/${app.id}`);
        expect(prompt.url.searchParams.get("view")).toBe("accounts");
        expect(prompt.url.searchParams.has("rename")).toBe(false);
        yield* browser.checkpoint("Name the connected account over the app");
        yield* browser.use("Save a recognizable name", (page) =>
          nameConnectedAccount(page, "Work key"),
        );
        yield* browser.use("The app shows the new name", (page) =>
          page
            .getByRole("radio", { name: "Work key", exact: true, checked: true })
            .waitFor({ state: "visible" }),
        );
        expect(yield* savedLabel(created.id)).toBe("Work key");
        yield* browser.checkpoint("Named account selected for the app");

        // Credentials are replaced from the app that selects the account, not from Accounts.
        yield* browser.use("Open the account's actions on the app", (page) =>
          page
            .getByRole("button", { name: "Manage Work key", exact: true })
            .click()
            .then(() => page.getByRole("menu").waitFor({ state: "visible" })),
        );
        yield* browser.checkpoint("Account actions on the app's selected account");
        yield* browser.use("Replace its credentials", (page) =>
          page.getByRole("menuitem", { name: "Update credentials", exact: true }).click(),
        );
        const reconnect = yield* browser.use("The reconnect dialog opens", (page) => {
          const dialog = page.getByRole("dialog", {
            name: "Reconnect Naming fixture",
            exact: true,
          });
          return dialog.waitFor({ state: "visible" }).then(() => dialog);
        });
        yield* browser.use("Enter a replacement API key", () =>
          reconnect.getByLabel("Token", { exact: true }).fill("synthetic-naming-token-2"),
        );
        yield* browser.use("Save the replacement credentials", () =>
          reconnect.getByRole("button", { name: "Save credentials", exact: true }).click(),
        );
        yield* browser.use("Replacing credentials closes the dialog", () =>
          reconnect.waitFor({ state: "hidden" }),
        );
        expect(
          yield* browser.use("Replacing credentials does not ask for a name", (page) =>
            nameAccountDialog(page).count(),
          ),
        ).toBe(0);
        yield* browser.use("The account keeps its name", (page) =>
          page.getByRole("button", { name: "Manage Work key", exact: true }).waitFor(),
        );
        expect(yield* savedLabel(created.id)).toBe("Work key");
        yield* browser.checkpoint("Updated credentials keep the account name");

        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
        const submit = (label?: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            const account = yield* body(
              Account,
              yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection.id}/submit`,
                {
                  method: "key",
                  ...(label === undefined ? {} : { label }),
                  fields: { token: "synthetic-naming-token" },
                },
              ),
            );
            accounts.push(account.id);
            return account.label;
          });
        // The renamed account freed "Default"; later unnamed accounts take the next free name.
        expect(yield* submit()).toBe("Default");
        expect(yield* submit()).toBe("Default 2");
        expect(yield* submit("Supplied name")).toBe("Supplied name");
        expect(yield* submit()).toBe("Default 3");
      }),
    ),
  );
});
