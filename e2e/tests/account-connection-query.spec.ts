import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import {
  accountNameField,
  accountNamePrompt,
  nameAccountDialog,
  nameConnectedAccount,
} from "../support/name-account.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

layer(HostedLive, { excludeTestServices: true })("Account connection", (it) => {
  it.effect(scenarios.accountConnectionQuery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Connection ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, defineProvider, mutation, object, secrets, string, router } from "apps";
const service = defineProvider({ name: "Connection fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({
  tools: router({
    echo: mutation({ description: "Echo with the connected account", input: object({ text: string() }) },
    async (_, input) => ({ text: input.text, connected: accounts.service.fields.token === "synthetic-connection-token" })),
  })
}));
`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)).status,
            ).toBe(200);
            if (account !== undefined)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`))
                  .status,
              ).toBe(200);
          }).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the new app before connecting its account", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        let created = 0;
        let connectionReads = 0;
        yield* browser.use("Observe account connection requests", (page) =>
          page.route(/\/connections(?:\/[^/]+)?$/, (route) => {
            if (route.request().method() === "POST") created++;
            if (route.request().method() === "GET") connectionReads++;
            return route.continue();
          }),
        );
        yield* browser.use("Connect directly from the app account card", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        yield* browser.use("Credentials open inside the app", (page) =>
          page.getByRole("dialog").waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The app route stays open", (page) =>
            page.evaluate(() => location.pathname),
          ),
        ).toBe(`/org/${actors.organization.slug}/apps/${app.id}`);
        expect(created).toBe(0);
        expect(connectionReads).toBe(0);
        expect(
          yield* browser.use("The credential form does not ask for a name", (page) =>
            page.getByRole("dialog").getByRole("textbox", { name: "Account name" }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Enter the synthetic API key", (page) =>
          page.getByLabel("Token", { exact: true }).fill("synthetic-connection-token"),
        );
        let dropped = false;
        let committed: unknown;
        yield* browser.use("Lose the first save response after the server commits", (page) =>
          page.route(/\/connections\/[^/]+\/submit$/, (route) => {
            if (dropped) return route.fallback();
            dropped = true;
            return route
              .fetch()
              .then((response) => response.json())
              .then((value: unknown) => {
                committed = value;
                return route.abort("failed");
              });
          }),
        );
        yield* browser.use("Submit the credentials once", (page) =>
          page.getByRole("button", { name: "Connect account", exact: true }).click(),
        );
        yield* browser.use("A lost response keeps the form open for retry", (page) =>
          page
            .getByRole("dialog")
            .getByText("Can’t reach Executor", { exact: true })
            .waitFor({ state: "visible" }),
        );
        account = (yield* Schema.decodeUnknownEffect(Resource)(committed)).id;
        expect(created).toBe(1);
        expect(
          yield* browser.use("The credential survives the failed response", (page) =>
            page.getByRole("dialog").getByLabel("Token", { exact: true }).inputValue(),
          ),
        ).toBe("synthetic-connection-token");
        const timeOrigin = yield* browser.use("Remember this document before saving", (page) =>
          page.evaluate(() => performance.timeOrigin),
        );
        const paths = [actors.organization.slug, actors.organization.id].map(
          (reference) => `/api/organizations/${reference}/apps/${app.id}/profiles`,
        );
        const read = yield* holdQuery(paths, "continue", { allRequests: true });
        const saved = yield* browser.use("Save credentials through the account form", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname.endsWith("/submit"),
            ),
            page.getByRole("button", { name: "Connect account", exact: true }).click(),
          ]).then(([response]) =>
            response.json().then((value: unknown) => ({ status: response.status(), body: value })),
          ),
        );
        expect(saved.status).toBe(200);
        expect((yield* Schema.decodeUnknownEffect(Resource)(saved.body)).id).toBe(account);
        expect(created).toBe(1);
        expect(connectionReads).toBe(0);
        yield* browser.use("Saving closes the credential dialog and asks for a name", (page) =>
          page
            .getByRole("dialog", { name: "Connect Connection fixture", exact: true })
            .waitFor({ state: "hidden" })
            .then(() => accountNamePrompt(page))
            .then(() =>
              nameAccountDialog(page)
                .getByText("Connection fixture is connected. Choose a name you’ll recognize.", {
                  exact: true,
                })
                .waitFor({ state: "visible" }),
            ),
        );
        expect(
          yield* browser.use("The name starts as the server's default", (page) =>
            accountNameField(page).inputValue(),
          ),
        ).toBe("Default");
        const selections = yield* body(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              accounts: Schema.Struct({ service: Schema.String }),
            }),
          ),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/profiles`),
        );
        expect(selections).toHaveLength(1);
        expect(selections[0]?.accounts.service).toBe(account);
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}`)).body,
        ).not.toHaveProperty("accounts");
        const search = yield* browser.use(
          "Saving returns to the app without a document navigation",
          (page) =>
            page
              .waitForURL(
                (url) => url.pathname === `/org/${actors.organization.slug}/apps/${app.id}`,
              )
              .then(() => new URL(page.url()).searchParams),
        );
        expect(search.has("rename")).toBe(false);
        yield* browser.checkpoint("App waits for confirmed profile bindings");
        const refreshPath = yield* evidence.step(
          "Saving starts a fresh profile metadata read",
          read.requested,
        );
        // The modal prompt hides the page from assistive technology while it is open.
        // The Accounts tab keeps its previous content while the profile read is held.
        expect(
          yield* browser.use("The pending profile read keeps the tab on screen", (page) =>
            page
              .getByRole("status", { name: "Loading accounts", exact: true, includeHidden: true })
              .count(),
          ),
        ).toBe(0);
        yield* browser.use("Type a name while the Accounts tab reloads", (page) =>
          accountNameField(page).fill(name),
        );
        yield* read.release;
        yield* browser.use("The new account appears on the same app", (page) =>
          page
            .getByRole("radio", { name: "Default", exact: true, includeHidden: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The naming dialog and its draft survive the reload", (page) =>
            nameAccountDialog(page)
              .isVisible()
              .then((visible) =>
                accountNameField(page)
                  .inputValue()
                  .then((draft) => ({ visible, draft })),
              ),
          ),
        ).toEqual({ visible: true, draft: name });
        yield* browser.checkpoint("Name the connected account after the Accounts tab reloads");
        yield* browser.use("Save the account's name", (page) => nameConnectedAccount(page, name));
        yield* browser.use("The app shows the saved name", (page) =>
          page.getByRole("radio", { name, exact: true }).waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The new account is the selected one", (page) =>
            page.getByRole("radio", { name, exact: true }).isChecked(),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("The accounts tab stays selected", (page) =>
            page.evaluate(() => new URL(location.href).searchParams.get("view")),
          ),
        ).toBe("accounts");
        yield* browser.use("The credential dialog closes after saving", (page) =>
          page.getByRole("dialog").waitFor({ state: "hidden" }),
        );
        expect(
          yield* browser.use("No second save is needed", (page) =>
            page.getByRole("button", { name: "Save selection", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Account connected in place");
        yield* browser.use("Connect another account from the list", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        yield* browser.use("Another connection opens in the shared dialog", (page) =>
          page
            .getByRole("heading", { name: "Connect Connection fixture", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Only one dialog is open", (page) => page.getByRole("dialog").count()),
        ).toBe(1);
        yield* browser.use("Close without changing the account", (page) =>
          page.getByRole("button", { name: "Close", exact: true }).click(),
        );

        yield* browser.use("Open the tools now available to this app", (page) =>
          page.getByRole("link", { name: "Tools", exact: true }).click(),
        );
        yield* browser.use("The connected app's tools load without refreshing", (page) =>
          page.getByRole("button", { name: "echo", exact: true }).waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The original document remains mounted", (page) =>
            page.evaluate(() => performance.timeOrigin),
          ),
        ).toBe(timeOrigin);
        yield* browser.checkpoint("Connected app tools loaded without refresh");
        yield* evidence.json("account-connection-query.json", {
          refreshPath,
          accountSelected: true,
          toolsVisibleWithoutReload: true,
        });
      }),
    ),
  );
});
