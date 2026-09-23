import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { saveAndDeploy, Workspace } from "../support/app-authoring.ts";
import { App, Resource } from "../support/contracts.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("App accounts", (it) => {
  it.effect(scenarios.appAccountPicker.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Account choices ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, defineProvider, object, secrets, string } from "apps";
const service = defineProvider({ name: "Account fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { primary: service, mailboxes: service.many() } }, async () => ({ queries: {} }));`,
            },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const profile = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/profiles`, {
            accounts: {},
            idempotencyKey: randomUUID(),
          }),
        );
        for (const label of ["First account", "Second account"]) {
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "primary",
              profile: profile.id,
            }),
          );
          const saved = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            { method: "key", label, fields: { token: "synthetic-token" } },
          );
          expect(saved.status).toBe(200);
          accounts.push((yield* body(Resource, saved)).id);
        }
        yield* browser.login(actors.owner);
        const url = `/org/${actors.organization.slug}/apps/${app.id}?view=accounts&profile=${profile.id}`;
        yield* browser.use("Open app accounts", (page) => page.goto(url));
        yield* browser.use("Change the saved account in place", (page) =>
          page
            .getByRole("region", { name: "Account fixture (primary)", exact: true })
            .getByRole("button", { name: "Switch Account fixture account", exact: true })
            .click(),
        );
        expect(
          yield* browser.use("Already selected scalar account is absent from the chooser", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: /Second account/ })
              .count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Saved account picker");
        const failure = yield* holdQuery(
          [actors.organization.slug, actors.organization.id].map(
            (id) => `/api/organizations/${id}/apps/${app.id}/profiles/${profile.id}`,
          ),
          "fail",
          { method: "PATCH" },
        );
        yield* browser.use("Choose the first account", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: /First account/ })
            .click(),
        );
        yield* failure.requested;
        expect(
          yield* browser.use("Choice is disabled while saving", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: /First account/ })
              .isDisabled(),
          ),
        ).toBe(true);
        yield* failure.release;
        yield* browser.use("A failed save stays in the picker", (page) =>
          page
            .getByRole("dialog")
            .getByText("Unable to complete this request", { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Failed choice can be retried");
        yield* browser.use("Retry the same account choice", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: /First account/ })
            .click(),
        );
        yield* browser.use("Picker closes after the confirmed save", (page) =>
          page
            .getByRole("dialog", { name: "Account fixture accounts", exact: true })
            .waitFor({ state: "hidden" }),
        );
        const selected = yield* body(
          Schema.Struct({
            accounts: Schema.Record(
              Schema.String,
              Schema.Union([Schema.String, Schema.Array(Schema.String)]),
            ),
          }),
          yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${app.id}/profiles/${profile.id}`,
          ),
        );
        expect(selected.accounts.primary).toBe(accounts[0]);
        expect(
          yield* browser.use("Still on this app", (page) =>
            page.evaluate(() => location.pathname + location.search),
          ),
        ).toBe(url);
        yield* browser.use("Choose several saved accounts", (page) =>
          page
            .getByRole("region", { name: "Account fixture (mailboxes)", exact: true })
            .getByRole("button", { name: "Add Account fixture account", exact: true })
            .click(),
        );
        yield* browser.use("Select the first mailbox", (page) =>
          page
            .getByRole("dialog")
            .getByRole("checkbox", { name: /First account/ })
            .check(),
        );
        yield* browser.use("Select the second mailbox", (page) =>
          page
            .getByRole("dialog")
            .getByRole("checkbox", { name: /Second account/ })
            .check(),
        );
        const refresh = yield* holdQuery(
          [actors.organization.slug, actors.organization.id].map(
            (id) => `/api/organizations/${id}/apps/${app.id}`,
          ),
          "fail",
        );
        yield* refreshVisiblePage;
        yield* refresh.requested;
        expect(
          yield* browser.use("Background refresh preserves the choice", (page) =>
            page
              .getByRole("dialog")
              .getByRole("checkbox", { name: /Second account/ })
              .isChecked(),
          ),
        ).toBe(true);
        yield* refresh.release;
        yield* browser.use("Refresh failure stays outside the open picker", (page) =>
          page
            .getByText("Unable to complete this request", { exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Refresh failure keeps the edited selection", (page) =>
            page
              .getByRole("dialog")
              .getByRole("checkbox", { name: /Second account/ })
              .isChecked(),
          ),
        ).toBe(true);
        const savedBoth = yield* browser.use("Save both mailboxes together", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "PATCH" &&
                new URL(response.url()).pathname.endsWith(`/profiles/${profile.id}`),
            ),
            page.getByRole("button", { name: "Use selected accounts", exact: true }).click(),
          ]).then(([response]) => response.status()),
        );
        expect(savedBoth).toBe(200);
        yield* browser.use("Both accounts remain selected", (page) =>
          page
            .getByRole("region", { name: "Account fixture (mailboxes)", exact: true })
            .getByRole("link", { name: "Second account", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* Effect.gen(function* () {
          yield* browser.use("All saved accounts added opens a focused connection modal", (page) =>
            page
              .getByRole("region", { name: "Account fixture (mailboxes)", exact: true })
              .getByRole("button", { name: "Add Account fixture account", exact: true })
              .click(),
          );
          const dialog = yield* browser.use(
            "All saved accounts added opens a focused connection modal",
            (page) =>
              Promise.resolve(
                page.getByRole("dialog", {
                  name: "Connect Account fixture",
                  exact: true,
                }),
              ),
          );
          yield* browser.use("All saved accounts added opens a focused connection modal", () =>
            dialog.waitFor(),
          );
          yield* browser.use("All saved accounts added opens a focused connection modal", () =>
            dialog.getByRole("button", { name: "Connect account", exact: true }).waitFor(),
          );
          expect(
            yield* browser.use("New accounts can be named in the first dialog", () =>
              dialog.getByLabel("Account name", { exact: true }).inputValue(),
            ),
          ).toBe("Default");
          expect(
            yield* browser.use("All saved accounts added opens a focused connection modal", () =>
              dialog.getByRole("button", { name: "Use selected accounts", exact: true }).count(),
            ),
          ).toBe(0);
          expect(
            yield* browser.use("All saved accounts added opens a focused connection modal", () =>
              dialog
                .getByRole("button", { name: "Stop using these accounts", exact: true })
                .count(),
            ),
          ).toBe(0);
          yield* browser.use("All saved accounts added opens a focused connection modal", () =>
            dialog.press("Escape"),
          );
        });
        yield* Effect.gen(function* () {
          const provider = yield* browser.use("Remove one mailbox from the profile", (page) =>
            Promise.resolve(
              page.getByRole("region", {
                name: "Account fixture (mailboxes)",
                exact: true,
              }),
            ),
          );
          yield* browser.use("Remove one mailbox from the profile", () =>
            provider.getByRole("link", { name: "Second account", exact: true }).hover(),
          );
          yield* browser.use("Remove one mailbox from the profile", () =>
            provider.getByRole("button", { name: "Remove Second account", exact: true }).click(),
          );
          yield* browser.use("Remove one mailbox from the profile", () =>
            provider
              .getByRole("link", { name: "Second account", exact: true })
              .waitFor({ state: "hidden" }),
          );
        });
        const afterMailboxRemoval = yield* body(
          Schema.Struct({
            accounts: Schema.Record(
              Schema.String,
              Schema.Union([Schema.String, Schema.Array(Schema.String)]),
            ),
          }),
          yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${app.id}/profiles/${profile.id}`,
          ),
        );
        expect(afterMailboxRemoval.accounts).toEqual({
          primary: accounts[0],
          mailboxes: [accounts[0]],
        });
        yield* Effect.gen(function* () {
          yield* browser.use("Only accounts not yet added appear in the mailbox chooser", (page) =>
            page
              .getByRole("region", { name: "Account fixture (mailboxes)", exact: true })
              .getByRole("button", { name: "Add Account fixture account", exact: true })
              .click(),
          );
          const dialog = yield* browser.use(
            "Only accounts not yet added appear in the mailbox chooser",
            (page) =>
              Promise.resolve(
                page.getByRole("dialog", {
                  name: "Account fixture accounts",
                  exact: true,
                }),
              ),
          );
          expect(
            yield* browser.use("Only accounts not yet added appear in the mailbox chooser", () =>
              dialog.getByRole("checkbox", { name: /First account/ }).count(),
            ),
          ).toBe(0);
          yield* browser.use("Only accounts not yet added appear in the mailbox chooser", () =>
            dialog.getByRole("checkbox", { name: /Second account/ }).waitFor(),
          );
          yield* browser.use("Only accounts not yet added appear in the mailbox chooser", () =>
            dialog.getByRole("button", { name: "Use selected accounts", exact: true }).click(),
          );
          yield* browser.use("Only accounts not yet added appear in the mailbox chooser", () =>
            dialog.waitFor({ state: "hidden" }),
          );
        });
        yield* Effect.gen(function* () {
          const provider = yield* browser.use(
            "Remove the scalar binding without deleting its saved account",
            (page) =>
              Promise.resolve(
                page.getByRole("region", {
                  name: "Account fixture (primary)",
                  exact: true,
                }),
              ),
          );
          yield* browser.use("Remove the scalar binding without deleting its saved account", () =>
            provider.getByRole("link", { name: "First account", exact: true }).hover(),
          );
          yield* browser.use("Remove the scalar binding without deleting its saved account", () =>
            provider.getByRole("button", { name: "Remove First account", exact: true }).click(),
          );
          yield* browser.use("Remove the scalar binding without deleting its saved account", () =>
            provider
              .getByRole("link", { name: "First account", exact: true })
              .waitFor({ state: "hidden" }),
          );
          yield* browser.use("Remove the scalar binding without deleting its saved account", () =>
            provider
              .getByRole("button", { name: "Add Account fixture account", exact: true })
              .waitFor(),
          );
          expect(
            yield* browser.use("Empty providers omit the account count label", () =>
              provider.getByText("No accounts", { exact: true }).count(),
            ),
          ).toBe(0);
        });
        yield* browser.checkpoint("Empty account row without count");
        const afterScalarRemoval = yield* body(
          Schema.Struct({
            accounts: Schema.Record(
              Schema.String,
              Schema.Union([Schema.String, Schema.Array(Schema.String)]),
            ),
          }),
          yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${app.id}/profiles/${profile.id}`,
          ),
        );
        expect(afterScalarRemoval.accounts).toEqual({ mailboxes: [accounts[0]] });
        for (const account of accounts)
          expect(
            (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account}`)).status,
          ).toBe(200);
        for (const account of accounts)
          yield* api.request(actors.owner, "PATCH", `${prefix}/accounts/${account}`, {
            label: "Default",
          });
        yield* browser.use("Reload duplicate account labels", (page) => page.goto(url));
        yield* browser.use("Distinguish identically named accounts", (page) =>
          page
            .getByRole("region", { name: "Account fixture (primary)", exact: true })
            .getByRole("button", { name: "Add Account fixture account", exact: true })
            .click(),
        );
        const labels = yield* browser.use("Read duplicate choice details", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: /^Default/ })
            .allTextContents(),
        );
        expect(labels).toHaveLength(2);
        expect(labels.every((label) => label.includes("Added"))).toBe(true);
        expect(new Set(labels).size).toBe(2);
        yield* browser.use("Use the picker at phone width", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("Account picker at phone width");
        expect(
          yield* browser.use("No horizontal overflow", (page) =>
            page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect(scenarios.appAccountOAuth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Sign-in ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, defineProvider, oauth2 } from "apps";
const service = defineProvider({ name: "Browser fixture", auth: { oauth: oauth2({ authorizationUrl: "https://oauth.example.test/authorize", tokenUrl: "https://oauth.example.test/token", scopes: ["read"] }) } });
export default defineApp({ accounts: { service } }, async () => ({ queries: {} }));`,
            },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        const appUrl = `/org/${actors.organization.slug}/apps/${app.id}`;
        yield* browser.use("Open the app overview", (page) => page.goto(`${appUrl}?view=overview`));
        yield* browser.use("Wait for the overview account provider", (page) =>
          page
            .getByRole("region", { name: "App accounts", exact: true })
            .getByText("Browser fixture", { exact: true })
            .waitFor({ state: "visible" }),
        );
        let created = 0;
        let connectionReads = 0;
        yield* browser.use("Observe connection creation and metadata reads", (page) =>
          page.route(/\/connections(?:\/[^/]+)?$/, (route) => {
            if (route.request().method() === "POST") created++;
            if (route.request().method() === "GET") connectionReads++;
            return route.continue();
          }),
        );
        let starts = 0;
        yield* browser.use("Observe OAuth attempts", (page) =>
          page.route(/\/oauth\/start$/, (route) => {
            if (route.request().method() === "POST") starts++;
            return route.continue();
          }),
        );
        yield* Effect.gen(function* () {
          yield* browser.use("Select accounts without creating a setup first", (page) =>
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "Accounts", exact: true })
              .click(),
          );
          yield* browser.use("Select accounts without creating a setup first", (page) =>
            page.getByRole("button", { name: "Add Browser fixture account", exact: true }).click(),
          );
        });
        yield* browser.use("The account name is available before OAuth", (page) =>
          page
            .getByRole("dialog")
            .getByRole("textbox", { name: "Account name", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Wait for setup status to resolve", (page) =>
          page
            .getByRole("status", { name: "Preparing connection", exact: true })
            .waitFor({ state: "hidden" }),
        );
        expect(
          yield* browser.use("Required client fields are present before submission", (page) =>
            page.getByRole("textbox", { name: "Client ID", exact: true }).count(),
          ),
        ).toBe(1);
        yield* browser.use("A provider requiring a client shows its fields upfront", (page) =>
          page
            .getByRole("textbox", { name: "Client ID", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Public browser clients need no secret or protocol selector", (page) => {
          const dialog = page.getByRole("dialog");
          return Promise.all([
            dialog.getByLabel("Client secret", { exact: true }).count(),
            dialog.getByRole("combobox").count(),
            dialog.getByRole("button", { name: "Copy redirect URL" }).count(),
          ]).then((counts) => {
            expect(counts).toEqual([0, 0, 1]);
          });
        });
        expect(
          yield* browser.use("The manual-client toggle is unnecessary", (page) =>
            page.getByRole("button", { name: "Use your own OAuth client", exact: true }).count(),
          ),
        ).toBe(0);
        expect(starts).toBe(0);
        expect(created).toBe(0);
        expect(connectionReads).toBe(0);
        expect(
          yield* browser.use("Opening Connect keeps the Accounts tab selected", (page) =>
            page.evaluate(() => location.pathname + location.search),
          ),
        ).toBe(`${appUrl}?view=accounts`);
        yield* browser.use("Name the account before authorization", (page) =>
          page
            .getByRole("textbox", { name: "Account name", exact: true })
            .fill("Work browser account"),
        );
        const cachedSetup = yield* body(
          Schema.Struct({ accountSetup: Schema.Struct({ redirectUri: Schema.String }) }),
          yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
        );
        yield* browser.use("Manual setup uses the configured callback", (page) =>
          page
            .getByText(cachedSetup.accountSetup.redirectUri, { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Provide the synthetic public client", (page) =>
          page
            .getByRole("textbox", { name: "Client ID", exact: true })
            .fill("synthetic-browser-client"),
        );
        yield* browser.checkpoint("Required client setup is shown before authorization");
        const origin = yield* browser.use("Remember the app origin", (page) =>
          page.evaluate(() => location.origin),
        );
        yield* browser.use("Simulate the external provider cancelling consent", (page) =>
          page.route("https://oauth.example.test/authorize**", (route) => {
            const authorization = new URL(route.request().url());
            const callback = new URL("/oauth/callback", origin);
            callback.searchParams.set("error", "access_denied");
            callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
            return route.fulfill({ status: 302, headers: { location: callback.href } });
          }),
        );
        const attempted = yield* browser.use("Enter submits the name and client together", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname.endsWith("/oauth/start") &&
                response.request().method() === "POST",
            ),
            page.getByRole("textbox", { name: "Account name", exact: true }).press("Enter"),
          ]).then(([response]) => ({
            status: response.status(),
            input: response.request().postDataJSON(),
          })),
        );
        expect(attempted.status).toBe(200);
        expect(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ label: Schema.String }))(
            attempted.input,
          )).label,
        ).toBe("Work browser account");
        yield* browser.use("Cancellation has a useful recovery action", (page) =>
          page
            .getByRole("heading", { name: "Connection cancelled", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(created).toBe(1);
        expect(connectionReads).toBe(0);
        yield* browser.checkpoint("Cancelled sign-in returns to this app");
        yield* browser.use("Return directly to the same app", (page) =>
          page.getByRole("link", { name: "Back to app", exact: true }).click(),
        );
        yield* browser.use("Choose the account after cancellation", (page) =>
          page.getByRole("button", { name: "Add Browser fixture account", exact: true }).click(),
        );
        expect(
          yield* browser.use("Cancellation retained the app and organization", (page) =>
            page.evaluate(() => ({
              path: location.pathname,
              view: new URL(location.href).searchParams.get("view"),
              profile: new URL(location.href).searchParams.get("profile"),
            })),
          ),
        ).toEqual({
          path: `/org/${actors.organization.slug}/apps/${app.id}`,
          view: "accounts",
          profile: expect.any(String),
        });

        yield* browser.use("The next attempt retains its Connect action", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Connect Browser fixture", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Cancelled sign-in does not save the manual client", (page) =>
            page.getByRole("textbox", { name: "Client ID", exact: true }).count(),
          ),
        ).toBe(1);
        yield* browser.use("Enter the client for this new attempt", (page) =>
          page
            .getByRole("textbox", { name: "Client ID", exact: true })
            .fill("synthetic-browser-client"),
        );
        yield* browser.use("Keep a draft while the app changes", (page) =>
          page
            .getByRole("textbox", { name: "Account name", exact: true })
            .fill("Draft before provider change"),
        );
        const appPath = `${prefix}/apps/${app.id}`;
        const workspace = yield* body(
          Workspace,
          yield* api.request(actors.owner, "GET", `${appPath}/workspace`),
        );
        const changed = yield* saveAndDeploy(actors.owner, appPath, {
          files: workspace.files.map((file) => ({
            ...file,
            content: file.content.replace("Browser fixture", "Changed browser fixture"),
          })),
        });
        expect(changed.status).toBe(200);
        const attemptsBeforeChange = starts;
        yield* browser.use("Submit the stale draft", (page) =>
          page.getByRole("textbox", { name: "Account name", exact: true }).press("Enter"),
        );
        yield* browser.use("A changed provider cannot receive the stale form", (page) =>
          page
            .getByText("The app’s account setup changed. Close this form and try again.", {
              exact: true,
            })
            .waitFor({ state: "visible" }),
        );
        expect(starts).toBe(attemptsBeforeChange);
        expect(
          yield* browser.use("The rejected draft remains available", (page) =>
            page.getByRole("textbox", { name: "Account name", exact: true }).inputValue(),
          ),
        ).toBe("Draft before provider change");
        yield* browser.checkpoint("Cached form rejected after provider changed");
      }),
    ),
  );
});
