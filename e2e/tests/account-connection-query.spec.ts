import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Account connection", (it) => {
  it.effect(scenarios.accountConnectionQuery.title, (context) =>
    withCase(
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
import { defineApp, defineProvider, mutation, object, secrets, string } from "apps";
const service = defineProvider({ name: "Connection fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({
  mutations: { echo: mutation({ description: "Echo with the connected account", input: object({ text: string() }) },
    async (_, input) => ({ text: input.text, connected: accounts.service.fields.token === "synthetic-connection-token" })) }
}));
`,
            },
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
          page.getByRole("button", { name: "Add Connection fixture account", exact: true }).click(),
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
        yield* browser.use("Name the synthetic account", (page) =>
          page.getByRole("textbox", { name: "Account name", exact: true }).fill(name),
        );
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
            .getByText("Unable to complete this request", { exact: true })
            .waitFor({ state: "visible" }),
        );
        account = (yield* Schema.decodeUnknownEffect(Resource)(committed)).id;
        expect(created).toBe(1);
        expect(
          yield* browser.use("The account name survives the failed response", (page) =>
            page.getByRole("textbox", { name: "Account name", exact: true }).inputValue(),
          ),
        ).toBe(name);
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
        yield* browser.use("Saving returns to the app without a document navigation", (page) =>
          page.waitForURL(
            (url) => url.pathname === `/org/${actors.organization.slug}/apps/${app.id}`,
          ),
        );
        yield* browser.checkpoint("App waits for confirmed profile bindings");
        const refreshPath = yield* evidence.step(
          "Saving starts a fresh profile metadata read",
          read.requested,
        );
        yield* browser.use("The pending profile read has a loading state", (page) =>
          page
            .getByRole("status", { name: "Loading accounts", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* read.release;
        yield* browser.use("The new account appears on the same app", (page) =>
          page.getByRole("link", { name, exact: true }).waitFor({ state: "visible" }),
        );
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
        yield* browser.use("Manage the connected account", (page) =>
          page
            .getByRole("button", { name: "Switch Connection fixture account", exact: true })
            .click(),
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
          page
            .getByRole("button", { name: "mutations.echo", exact: true })
            .waitFor({ state: "visible" }),
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
