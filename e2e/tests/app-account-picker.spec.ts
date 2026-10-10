import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Page } from "playwright";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { saveAndDeploy, Workspace } from "../support/app-authoring.ts";
import { App, Resource } from "../support/contracts.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

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
import { defineApp, defineProvider, object, secrets, string, router } from "apps";
const service = defineProvider({ name: "Account fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { primary: service, mailboxes: service.many() } }, async () => ({ tools: router({}) }));`,
            },
            appsManifest,
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
        const bindings = Effect.gen(function* () {
          return (yield* body(
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
          )).accounts;
        });
        const region = (slot: "primary" | "mailboxes") =>
          browser.use(`Find the ${slot} accounts`, (page) =>
            Promise.resolve(
              page.getByRole("region", { name: `Account fixture (${slot})`, exact: true }),
            ),
          );
        const saveChoice = (step: string, choose: (page: Page) => Promise<void>) =>
          browser.use(step, (page) =>
            Promise.all([
              page.waitForResponse(
                (response) =>
                  response.request().method() === "PATCH" &&
                  new URL(response.url()).pathname.endsWith(`/profiles/${profile.id}`),
              ),
              choose(page),
            ]).then(([response]) => response.status()),
          );
        // Rows read "<label>" or "<label> ✓" once the page shows the expected bindings.
        const listed = (slot: "primary" | "mailboxes", step: string, expected: readonly string[]) =>
          browser.use(step, (page) => {
            const name = `Account fixture (${slot})`;
            const read = (args: {
              readonly name: string;
              readonly expected: readonly string[];
            }) => {
              const inputs = document
                .querySelector(`section[aria-label="${args.name}"]`)
                ?.querySelectorAll("input[type=radio], [role=checkbox]");
              const rows = Array.from(inputs ?? [], (input) => {
                const on =
                  input instanceof HTMLInputElement
                    ? input.checked
                    : input.getAttribute("aria-checked") === "true";
                return `${input.closest("label")?.textContent ?? ""}${on ? " ✓" : ""}`;
              });
              return JSON.stringify(rows) === JSON.stringify(args.expected) ? rows : undefined;
            };
            const region = page.getByRole("region", { name, exact: true });
            // A timeout falls through so the assertion reports the rows actually shown.
            return region
              .waitFor()
              .then(() =>
                page
                  .waitForFunction(read, { name, expected }, { timeout: 10_000 })
                  .catch((error: unknown) => {
                    if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
                  }),
              )
              .then(() =>
                region.locator("input[type=radio], [role=checkbox]").evaluateAll((inputs) =>
                  inputs.map((input) => {
                    const on =
                      input instanceof HTMLInputElement
                        ? input.checked
                        : input.getAttribute("aria-checked") === "true";
                    return `${input.closest("label")?.textContent ?? ""}${on ? " ✓" : ""}`;
                  }),
                ),
              );
          });
        const shows = (slot: "primary" | "mailboxes", step: string, expected: readonly string[]) =>
          Effect.map(listed(slot, step, expected), (rows) => {
            expect(rows).toEqual(expected);
          });
        yield* browser.login(actors.owner);
        const url = `/org/${actors.organization.slug}/apps/${app.id}?view=accounts&profile=${profile.id}`;
        yield* browser.use("Open app accounts", (page) => page.goto(url));
        // Connecting both accounts to the single-account slot left the second one bound.
        yield* shows("primary", "Every saved account is listed oldest first", [
          "First account",
          "Second account ✓",
        ]);
        yield* shows("mailboxes", "Multiple-account choices start unchecked", [
          "First account",
          "Second account",
        ]);
        expect(
          yield* browser.use("Choosing needs no dialog", (page) =>
            page.getByRole("dialog").count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Saved accounts listed in place");
        const failure = yield* holdQuery(
          [actors.organization.slug, actors.organization.id].map(
            (id) => `/api/organizations/${id}/apps/${app.id}/profiles/${profile.id}`,
          ),
          "fail",
          { method: "PATCH" },
        );
        const primary = yield* region("primary");
        yield* browser.use("Choose the first account", () =>
          primary.getByRole("radio", { name: "First account", exact: true }).click(),
        );
        yield* failure.requested;
        expect(
          yield* browser.use("Choices are disabled while saving", () =>
            primary.getByRole("radio", { name: "Second account", exact: true }).isDisabled(),
          ),
        ).toBe(true);
        yield* failure.release;
        yield* browser.use("A failed save is reported in place", (page) =>
          page
            .getByText("Can’t reach Executor", { exact: true })
            .first()
            .waitFor({ state: "visible" }),
        );
        yield* shows("primary", "A failed choice keeps the saved account", [
          "First account",
          "Second account ✓",
        ]);
        expect((yield* bindings).primary).toBe(accounts[1]);
        yield* browser.checkpoint("Failed choice can be retried");
        expect(
          yield* saveChoice("Retry the same account choice", () =>
            primary.getByRole("radio", { name: "First account", exact: true }).click(),
          ),
        ).toBe(200);
        yield* shows("primary", "The retried choice is shown", [
          "First account ✓",
          "Second account",
        ]);
        expect((yield* bindings).primary).toBe(accounts[0]);
        expect(
          yield* browser.use("Still on this app", (page) =>
            page.evaluate(() => location.pathname + location.search),
          ),
        ).toBe(url);
        yield* browser.use("Reload the Accounts tab", (page) => page.goto(url));
        yield* shows("primary", "The choice survives a reload", [
          "First account ✓",
          "Second account",
        ]);
        expect(
          yield* saveChoice("Switch the single account", (page) =>
            page
              .getByRole("region", { name: "Account fixture (primary)", exact: true })
              .getByRole("radio", { name: "Second account", exact: true })
              .click(),
          ),
        ).toBe(200);
        expect((yield* bindings).primary).toBe(accounts[1]);
        yield* browser.use("Reload after switching", (page) => page.goto(url));
        yield* shows("primary", "The switched account survives a reload", [
          "First account",
          "Second account ✓",
        ]);
        const mailboxes = yield* region("mailboxes");
        expect(
          yield* saveChoice("Check the first mailbox", () =>
            mailboxes.getByRole("checkbox", { name: "First account", exact: true }).click(),
          ),
        ).toBe(200);
        expect(
          yield* saveChoice("Check the second mailbox", () =>
            mailboxes.getByRole("checkbox", { name: "Second account", exact: true }).click(),
          ),
        ).toBe(200);
        expect((yield* bindings).mailboxes).toEqual([accounts[0], accounts[1]]);
        const refresh = yield* holdQuery(
          [actors.organization.slug, actors.organization.id].map(
            (id) => `/api/organizations/${id}/apps/${app.id}`,
          ),
          "undeclared",
        );
        yield* refreshVisiblePage;
        yield* refresh.requested;
        yield* refresh.release;
        yield* browser.use("Refresh failure is reported", (page) =>
          page
            .getByText("Unable to complete this request", { exact: true })
            .first()
            .waitFor({ state: "visible" }),
        );
        yield* shows("mailboxes", "A failed refresh keeps the saved choices", [
          "First account ✓",
          "Second account ✓",
        ]);
        expect(
          yield* saveChoice("Uncheck one mailbox", () =>
            mailboxes.getByRole("checkbox", { name: "Second account", exact: true }).click(),
          ),
        ).toBe(200);
        expect(yield* bindings).toEqual({ primary: accounts[1], mailboxes: [accounts[0]] });
        yield* Effect.gen(function* () {
          yield* browser.use("Connect a new mailbox from the list", () =>
            mailboxes.getByRole("button", { name: "Connect new account", exact: true }).click(),
          );
          const dialog = yield* browser.use("Connect a new mailbox from the list", (page) =>
            Promise.resolve(page.getByRole("dialog", { name: "Connect Account fixture" })),
          );
          expect(
            yield* browser.use("New accounts are named after they connect, not before", () =>
              dialog.getByLabel("Account name", { exact: true }).count(),
            ),
          ).toBe(0);
          yield* browser.use("Enter the synthetic token", () =>
            dialog.getByLabel("Token", { exact: true }).fill("synthetic-token"),
          );
          yield* browser.use("Connect the new mailbox", () =>
            dialog.getByRole("button", { name: "Connect account", exact: true }).click(),
          );
          yield* browser.use("The dialog closes after connecting", () =>
            dialog.waitFor({ state: "hidden" }),
          );
          yield* browser.use("Name the new mailbox", (page) =>
            nameConnectedAccount(page, "Third account"),
          );
        });
        const connected = yield* bindings;
        const third = Array.isArray(connected.mailboxes)
          ? connected.mailboxes.find((id) => !accounts.includes(id))
          : undefined;
        if (third === undefined) return yield* Effect.die("The new mailbox was not bound");
        accounts.push(third);
        expect(connected).toEqual({ primary: accounts[1], mailboxes: [accounts[0], third] });
        yield* shows("mailboxes", "The new mailbox is bound at the end", [
          "First account ✓",
          "Second account",
          "Third account ✓",
        ]);
        yield* shows("primary", "The new account is offered to other slots", [
          "First account",
          "Second account ✓",
          "Third account",
        ]);
        yield* browser.checkpoint("New account connected and bound");
        yield* Effect.gen(function* () {
          yield* browser.use("Remove the scalar binding without deleting its saved account", () =>
            primary.getByRole("radio", { name: "Second account", exact: true }).hover(),
          );
          yield* browser.use(
            "Remove the scalar binding without deleting its saved account",
            (page) =>
              primary
                .getByRole("button", { name: "Manage Second account", exact: true })
                .click()
                .then(() => page.getByRole("menuitem", { name: "Remove", exact: true }).click()),
          );
          yield* browser.use("Remove the scalar binding without deleting its saved account", () =>
            primary.locator(":checked").waitFor({ state: "detached" }),
          );
        });
        const unused = yield* browser.use("Find the unused account prompt", (page) =>
          Promise.resolve(page.getByRole("dialog", { name: "Delete unused account?" })),
        );
        yield* browser.use("No app uses the removed account, so deletion is offered", () =>
          unused.waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The prompt names the account and explains accounts and apps", () =>
            Promise.all([
              unused.getByText("Second account · Account fixture", { exact: true }).count(),
              unused.getByText("Accounts are saved separately from apps", { exact: false }).count(),
            ]),
          ),
        ).toEqual([1, 1]);
        yield* browser.use("Let the prompt finish opening", (page) =>
          page.waitForFunction(() =>
            document.getAnimations().every((animation) => animation.playState !== "running"),
          ),
        );
        yield* browser.checkpoint("Unused account prompt");
        yield* browser.use("Keep the unused account", () =>
          unused.getByRole("button", { name: "Keep account", exact: true }).click(),
        );
        yield* browser.use("Keeping the account closes the prompt", () =>
          unused.waitFor({ state: "hidden" }),
        );
        expect(yield* bindings).toEqual({ mailboxes: [accounts[0], third] });
        for (const account of accounts)
          expect(
            (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account}`)).status,
          ).toBe(200);
        // Unselecting is not a removal: it never reads the account's usage or offers deletion.
        const usageReads: string[] = [];
        const onRequest = (request: { method: () => string; url: () => string }) => {
          if (
            request.method() === "GET" &&
            new URL(request.url()).pathname.endsWith(`/accounts/${third}`)
          )
            usageReads.push(request.url());
        };
        yield* browser.use("Watch for account usage reads", (page) =>
          Promise.resolve(page.on("request", onRequest)),
        );
        expect(
          yield* saveChoice("Unselect the mailbox only it uses", () =>
            mailboxes.getByRole("checkbox", { name: "Third account", exact: true }).click(),
          ),
        ).toBe(200);
        expect(
          yield* saveChoice("Select that mailbox again", () =>
            mailboxes.getByRole("checkbox", { name: "Third account", exact: true }).click(),
          ),
        ).toBe(200);
        yield* browser.use("Stop watching account usage reads", (page) =>
          Promise.resolve(page.off("request", onRequest)),
        );
        expect(usageReads).toEqual([]);
        expect(
          yield* browser.use("Unselecting offers no deletion", (page) =>
            page.getByRole("dialog").count(),
          ),
        ).toBe(0);
        expect(yield* bindings).toEqual({ mailboxes: [accounts[0], third] });
        expect(
          yield* browser.use("Every mailbox has a menu", () =>
            Promise.all(
              ["First account", "Second account", "Third account"].map((label) =>
                mailboxes.getByRole("button", { name: `Manage ${label}`, exact: true }).count(),
              ),
            ),
          ),
        ).toEqual([1, 1, 1]);
        const removals: number[] = [];
        for (const label of ["First account", "Second account", "Third account"])
          removals.push(
            yield* browser.use(`Open the ${label} menu`, (page) =>
              mailboxes
                .getByRole("button", { name: `Manage ${label}`, exact: true })
                .click()
                .then(() => page.getByRole("menu").waitFor({ state: "visible" }))
                .then(() => page.getByRole("menuitem", { name: "Remove", exact: true }).count())
                .then((count) =>
                  page.keyboard
                    .press("Escape")
                    .then(() => page.getByRole("menu").waitFor({ state: "hidden" }))
                    .then(() => count),
                ),
            ),
          );
        expect(removals, "Only selected mailboxes offer removal").toEqual([1, 0, 1]);
        yield* Effect.gen(function* () {
          yield* browser.use("Remove the mailbox from its row", () =>
            mailboxes.getByRole("checkbox", { name: "Third account", exact: true }).hover(),
          );
          yield* browser.use("Remove the mailbox from its row", (page) =>
            mailboxes
              .getByRole("button", { name: "Manage Third account", exact: true })
              .click()
              .then(() => page.getByRole("menuitem", { name: "Remove", exact: true }).click()),
          );
        });
        yield* browser.use("Removing the last use offers deletion", () =>
          unused.waitFor({ state: "visible" }),
        );
        yield* browser.use("Delete the unused account", () =>
          unused.getByRole("button", { name: "Delete account", exact: true }).click(),
        );
        yield* browser.use("Deleting the account closes the prompt", () =>
          unused.waitFor({ state: "hidden" }),
        );
        const inventory = yield* body(
          Schema.Struct({ accounts: Schema.Array(Schema.Struct({ id: Schema.String })) }),
          yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
        );
        expect(inventory.accounts.map((account) => account.id)).not.toContain(third);
        expect(yield* bindings).toEqual({ mailboxes: [accounts[0]] });
        yield* shows("mailboxes", "The deleted account is no longer offered", [
          "First account ✓",
          "Second account",
        ]);
        yield* browser.use("Use the chooser at phone width", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("Account chooser at phone width");
        expect(
          yield* browser.use("No horizontal overflow", (page) =>
            page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ),
        ).toBe(true);
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: access.revision,
            audience: { kind: "private" },
          })).status,
        ).toBe(200);
        yield* browser.login(actors.admin);
        yield* browser.use("An administrator opens the private app's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("The Accounts tab explains the missing access", (page) =>
          page.getByText("This app is not shared with you.", { exact: false }).waitFor(),
        );
        expect(
          yield* browser.use("Users who cannot use the app get no chooser", (page) =>
            Promise.all([
              page.getByRole("radio").count(),
              page.getByRole("checkbox").count(),
              page.getByRole("button", { name: "Connect new account", exact: true }).count(),
            ]),
          ),
        ).toEqual([0, 0, 0]);
        yield* browser.checkpoint("Accounts without permission to use the app");
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
import { defineApp, defineProvider, oauth2, router } from "apps";
const service = defineProvider({ name: "Browser fixture", auth: { oauth: oauth2({ authorizationUrl: "https://oauth.example.test/authorize", tokenUrl: "https://oauth.example.test/token", scopes: ["read"] }) } });
export default defineApp({ accounts: { service } }, async () => ({ tools: router({}) }));`,
            },
            appsManifest,
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
            page.getByRole("button", { name: "Connect new account", exact: true }).click(),
          );
        });
        yield* browser.use("Wait for setup status to resolve", (page) =>
          page
            .getByRole("status", { name: "Preparing connection", exact: true })
            .waitFor({ state: "hidden" }),
        );
        expect(
          yield* browser.use("OAuth does not ask for an account name before sign-in", (page) =>
            page
              .getByRole("dialog")
              .getByRole("textbox", { name: "Account name", exact: true })
              .count(),
          ),
        ).toBe(0);
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
            // RFC 6749 §3.1.2: the redirect URI's own query survives an error response too.
            const denied = new URL(authorization.searchParams.get("redirect_uri") ?? origin);
            denied.searchParams.set("error", "access_denied");
            denied.searchParams.set("state", authorization.searchParams.get("state") ?? "");
            const callback = new URL("/oauth/callback", origin);
            callback.search = denied.search;
            return route.fulfill({ status: 302, headers: { location: callback.href } });
          }),
        );
        const attempted = yield* browser.use("Connect submits the client without a name", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname.endsWith("/oauth/start") &&
                response.request().method() === "POST",
            ),
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Connect Browser fixture", exact: true })
              .click(),
          ]).then(([response]) => ({
            status: response.status(),
            input: response.request().postDataJSON(),
          })),
        );
        expect(attempted.status).toBe(200);
        const submitted = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            method: Schema.String,
            client: Schema.Struct({ clientId: Schema.String }),
          }),
        )(attempted.input);
        expect(submitted.client.clientId).toBe("synthetic-browser-client");
        expect(Object.keys(submitted).sort()).toEqual(["client", "method"]);
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
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
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
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Connect Browser fixture", exact: true })
            .click(),
        );
        yield* browser.use("A changed provider cannot receive the stale form", (page) => {
          const form = page.getByRole("dialog");
          return Promise.all([
            form.getByText("App account setup changed", { exact: true }).waitFor(),
            form
              .getByText("This connection no longer matches the app’s requirements.", {
                exact: true,
              })
              .waitFor(),
            form
              .getByText("Close this form and start account setup again.", { exact: true })
              .waitFor(),
          ]);
        });
        expect(starts).toBe(attemptsBeforeChange);
        expect(
          yield* browser.use("The rejected draft remains available", (page) =>
            page.getByRole("textbox", { name: "Client ID", exact: true }).inputValue(),
          ),
        ).toBe("synthetic-browser-client");
        yield* browser.checkpoint("Cached form rejected after provider changed");
      }),
    ),
  );
});
