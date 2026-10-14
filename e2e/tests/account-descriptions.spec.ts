/** Agent-visible account descriptions, set while naming a new account and edited from its row. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { accountNamePrompt, accountNameField, nameAccountDialog } from "../support/name-account.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Account = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
});
const Detail = Schema.Struct({ account: Account });

layer(HostedLive, { excludeTestServices: true })("Account descriptions", (it) => {
  it.effect(scenarios.accountDescriptions.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Descriptions ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({ name: "Description fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));
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
        const saved = (account: string) =>
          api.request(actors.owner, "GET", `${prefix}/accounts/${account}`).pipe(
            Effect.flatMap((response) => body(Detail, response)),
            Effect.map((detail) => detail.account),
          );

        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Connect a new account from the list", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const connect = yield* browser.use("The connection dialog opens", (page) => {
          const dialog = page.getByRole("dialog", {
            name: "Connect Description fixture",
            exact: true,
          });
          return dialog.waitFor({ state: "visible" }).then(() => dialog);
        });
        yield* browser.use("Enter the synthetic API key", () =>
          connect.getByLabel("Token", { exact: true }).fill("synthetic-description-token"),
        );
        const submitted = yield* browser.use("Save the credentials", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                /\/connections\/[^/]+\/submit$/.test(new URL(response.url()).pathname),
            ),
            connect.getByRole("button", { name: "Connect account", exact: true }).click(),
          ]).then(([response]) => response.json() as Promise<unknown>),
        );
        const created = yield* Schema.decodeUnknownEffect(Account)(submitted);
        accounts.push(created.id);
        expect(created.description).toBeNull();

        // The naming prompt also takes the description agents read.
        const description = (page: Parameters<typeof nameAccountDialog>[0]) =>
          nameAccountDialog(page).getByRole("textbox", {
            name: "Description for agents",
            exact: true,
          });
        yield* browser.use("Name and describe the new account", (page) =>
          accountNamePrompt(page)
            .then(() => accountNameField(page).fill("Work key"))
            .then(() => description(page).fill("Reads only; use the sandbox account for writes.")),
        );
        yield* browser.checkpoint("Describe a new account while naming it");
        yield* browser.use("Save the name and description", (page) =>
          nameAccountDialog(page)
            .getByRole("button", { name: "Save name", exact: true })
            .click()
            .then(() => nameAccountDialog(page).waitFor({ state: "hidden" })),
        );
        expect(yield* saved(created.id)).toEqual({
          id: created.id,
          label: "Work key",
          description: "Reads only; use the sandbox account for writes.",
        });

        // The account list shows the description under the name.
        yield* browser.use("Open the account list", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts?account=${created.id}`),
        );
        yield* browser.use("The row shows the description", (page) =>
          page
            .getByText("Reads only; use the sandbox account for writes.", { exact: true })
            .waitFor({ state: "visible" }),
        );
        const openEdit = browser.use("Edit the account's details", (page) =>
          page
            .getByRole("button", { name: "Manage Work key", exact: true })
            .click()
            .then(() => page.getByRole("menuitem", { name: "Edit details", exact: true }).click())
            .then(() =>
              page
                .getByRole("dialog", { name: "Edit account", exact: true })
                .waitFor({ state: "visible" }),
            ),
        );
        const editDescription = (page: Parameters<typeof nameAccountDialog>[0]) =>
          page
            .getByRole("dialog", { name: "Edit account", exact: true })
            .getByRole("textbox", { name: "Description for agents", exact: true });
        const save = browser.use("Save the account details", (page) => {
          const dialog = page.getByRole("dialog", { name: "Edit account", exact: true });
          return dialog
            .getByRole("button", { name: "Save", exact: true })
            .click()
            .then(() => dialog.waitFor({ state: "hidden" }));
        });

        yield* openEdit;
        expect(
          yield* browser.use("The editor starts from the saved description", (page) =>
            editDescription(page).inputValue(),
          ),
        ).toBe("Reads only; use the sandbox account for writes.");
        yield* browser.use("Change the description", (page) =>
          editDescription(page).fill("Production workspace. Reads only."),
        );
        yield* browser.checkpoint("Edit an account description");
        yield* save;
        expect(yield* saved(created.id)).toEqual({
          id: created.id,
          label: "Work key",
          description: "Production workspace. Reads only.",
        });
        yield* browser.use("The row shows the new description", (page) =>
          page
            .getByText("Production workspace. Reads only.", { exact: true })
            .waitFor({ state: "visible" }),
        );

        // Clearing the field removes the description.
        yield* openEdit;
        yield* browser.use("Clear the description", (page) => editDescription(page).fill(""));
        yield* save;
        expect(yield* saved(created.id)).toEqual({
          id: created.id,
          label: "Work key",
          description: null,
        });
        yield* browser.use("The row no longer shows a description", (page) =>
          page
            .getByText("Production workspace. Reads only.", { exact: true })
            .waitFor({ state: "detached" }),
        );
      }),
    ),
  );
});
