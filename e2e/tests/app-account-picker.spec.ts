import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors, password } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { saveAndDeploy, Workspace } from "../support/app-authoring.ts";
import {
  accountLinks,
  connectionsPath,
  linkAccount,
  unlinkAccount,
} from "../support/app-accounts.ts";
import { App, Resource } from "../support/contracts.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { Target } from "../support/platform.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { enterClientDetails } from "../support/oauth-client-entry.ts";

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
const calendar = defineProvider({ name: "Calendar fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { primary: service, mailboxes: service.many(), calendar } } }, async () => ({ tools: router({}) }));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const appPath = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", appPath);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        /** Connect a key account for one requirement from the app, which links it there. */
        const connect = (requirement: string, label: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(appPath, "user", requirement),
                {},
              ),
            );
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "key", label, fields: { token: "synthetic-token" } },
            );
            expect(saved.status).toBe(200);
            const id = (yield* body(Resource, saved)).id;
            accounts.push(id);
            return id;
          });
        /** The owner's links, sorted, as `requirement:account` text. */
        const links = Effect.map(accountLinks(actors.owner, appPath), (pairs) =>
          pairs.map(([requirement, account]) => `${requirement}:${account}`).sort(),
        );
        const pairs = (...entries: ReadonlyArray<readonly [string, string]>) =>
          entries.map(([requirement, account]) => `${requirement}:${account}`).sort();
        // Connecting for the many() requirement links each account; the plain requirement takes
        // one of them, and unlinking keeps the saved account.
        const first = yield* connect("mailboxes", "First account");
        const second = yield* connect("mailboxes", "Second account");
        const third = yield* connect("mailboxes", "Third account");
        yield* linkAccount(actors.owner, appPath, "primary", first);
        yield* unlinkAccount(actors.owner, appPath, "mailboxes", third);
        expect(yield* links).toEqual(
          pairs(["primary", first], ["mailboxes", first], ["mailboxes", second]),
        );
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${third}`)).status,
        ).toBe(200);
        const region = (slot: "primary" | "mailboxes") =>
          browser.use(`Find the ${slot} accounts`, (page) =>
            Promise.resolve(
              page.getByRole("region", { name: `Account fixture (${slot})`, exact: true }),
            ),
          );
        const primary = yield* region("primary"),
          mailboxes = yield* region("mailboxes");
        /** Each account a requirement lists, with whether its radio or checkbox is checked. */
        const listed = (
          slot: "primary" | "mailboxes" | "calendar",
          step: string,
          expected: ReadonlyArray<readonly [string, boolean]>,
        ) =>
          browser.use(step, (page) => {
            const name =
              slot === "calendar" ? "Calendar fixture (calendar)" : `Account fixture (${slot})`;
            const selector = `section[aria-label="${name}"] :is([role="radio"], [role="checkbox"])`;
            const read = (args: {
              readonly selector: string;
              readonly expected: ReadonlyArray<readonly [string, boolean]>;
            }) =>
              JSON.stringify(
                Array.from(document.querySelectorAll(args.selector), (control) => [
                  control.getAttribute("aria-label"),
                  control.getAttribute("aria-checked") === "true",
                ]),
              ) === JSON.stringify(args.expected);
            // A timeout falls through so the assertion reports the controls actually shown.
            return page
              .waitForFunction(read, { selector, expected: [...expected] }, { timeout: 10_000 })
              .catch((error: unknown) => {
                if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
              })
              .then(() =>
                page
                  .locator(selector)
                  .evaluateAll((controls) =>
                    controls.map((control) => [
                      control.getAttribute("aria-label"),
                      control.getAttribute("aria-checked") === "true",
                    ]),
                  ),
              );
          });
        const shows = (
          slot: "primary" | "mailboxes" | "calendar",
          step: string,
          expected: ReadonlyArray<readonly [string, boolean]>,
        ) =>
          Effect.map(listed(slot, step, expected), (controls) => {
            expect(controls).toEqual(expected);
          });
        const failureShown = (step: string, message: string) =>
          browser.use(step, (page) =>
            page.getByText(message, { exact: true }).first().waitFor({ state: "visible" }),
          );
        /** Hold the owner's next link or unlink of one account to one requirement. */
        const holdLink = (method: "PUT" | "DELETE", requirement: string, account: string) =>
          holdQuery(
            [actors.organization.slug, actors.organization.id].map(
              (id) =>
                `/api/organizations/${id}/apps/${app.id}/accounts/user/${requirement}/${account}`,
            ),
            "fail",
            { method },
          );
        yield* browser.login(actors.owner);
        const pageErrors: string[] = [];
        yield* browser.use("Record uncaught page errors", (page) => {
          page.on("pageerror", (error) => pageErrors.push(error.message));
          return Promise.resolve();
        });
        const appPage = `/org/${actors.organization.slug}/apps/${app.id}`;
        const url = `${appPage}?view=accounts`;
        // Older setup links open the app's Accounts tab. The server answers them with that address
        // before any page renders; a redirect rendered by the page restarted itself whenever the
        // organization layout re-rendered, so it never finished and froze the tab. Links from
        // before profiles were removed may still name one; it no longer selects anything, so every
        // old link settles on the same address.
        const address = (at: URL) => at.pathname + at.search;
        const settles = (step: string) =>
          Effect.gen(function* () {
            expect(
              yield* browser.use(step, (page) =>
                page
                  .waitForURL((current) => address(current) === url)
                  .then(() =>
                    page
                      .getByRole("navigation", { name: "App navigation" })
                      .locator('[aria-current="page"]')
                      .textContent(),
                  ),
              ),
              "the tab the old link opens",
            ).toBe("Accounts");
          });
        const openSetupLink = (step: string, link: string) =>
          Effect.gen(function* () {
            expect(
              yield* browser.use(step, (page) =>
                page.goto(link).then((response) => response && address(new URL(response.url()))),
              ),
              "the document the old link opens",
            ).toBe(url);
            yield* settles(`${step} and settles there`);
          });
        const setupLink = `${appPage}/setup?profile=synthetic-legacy-profile`;
        yield* openSetupLink("An old setup link opens the Accounts tab", `${appPage}/setup`);
        yield* openSetupLink(
          "An old setup link naming a profile opens the Accounts tab",
          setupLink,
        );
        // Signed out, the link asks for sign-in first, which returns to it.
        const signIn = yield* browser.use("Open an old setup link signed out", (page) =>
          page
            .context()
            .clearCookies()
            .then(() => page.goto(setupLink))
            .then((response) => response && new URL(response.url())),
        );
        expect(signIn?.pathname, "a signed-out setup link").toBe("/login");
        expect(signIn?.searchParams.get("redirect"), "sign-in returns to the old link").toBe(
          setupLink,
        );
        if ((yield* Target).metadata.target === "self-host")
          yield* browser.use("Sign in with the owner's password", (page) =>
            page
              .getByLabel("Email", { exact: true })
              .fill("owner@example.test")
              .then(() => page.getByLabel("Password", { exact: true }).fill(password))
              .then(() => page.getByRole("button", { name: "Sign in", exact: true }).click()),
          );
        else {
          // Cloud fixture users cannot receive sign-in codes; the session arrives as a cookie and
          // the sign-in page is reloaded to continue its return navigation.
          const cookies = yield* actors.owner.cookies;
          yield* browser.use("Continue from sign-in with the owner's session", (page) =>
            page
              .context()
              .addCookies([...Redacted.value(cookies)])
              .then(() => page.reload()),
          );
        }
        // The rest of this scenario uses the page the old link opened after sign-in.
        yield* settles("Sign-in returns through the old setup link to the Accounts tab");
        // Each requirement lists every account of its provider the owner can use, by name: a
        // radio for the plain requirement, a checkbox for the many() one, linked ones checked.
        yield* shows("primary", "The plain requirement lists its choices as radios", [
          ["First account", true],
          ["Second account", false],
          ["Third account", false],
        ]);
        yield* shows("mailboxes", "The many() requirement lists its choices as checkboxes", [
          ["First account", true],
          ["Second account", true],
          ["Third account", false],
        ]);
        expect(
          yield* browser.use("Each requirement explains how calls use its accounts", (page) =>
            Promise.all([
              primary
                .getByText("primary · The app uses this account when you use it.", {
                  exact: true,
                })
                .count(),
              mailboxes
                .getByText("mailboxes · The app uses every account you link.", { exact: true })
                .count(),
              primary.getByRole("radio").count(),
              mailboxes.getByRole("checkbox").count(),
              page.getByRole("button", { name: "Replace", exact: true }).count(),
            ]),
          ),
        ).toEqual([1, 1, 3, 3, 0]);
        expect(
          yield* browser.use("Listing needs no dialog", (page) => page.getByRole("dialog").count()),
        ).toBe(0);
        expect(pageErrors).toEqual([]);
        yield* browser.checkpoint("Accounts listed in place");

        // A failed link keeps the current links and can be retried in place.
        const linkFailure = yield* holdLink("PUT", "mailboxes", third);
        yield* browser.use("Check the third mailbox", () =>
          mailboxes.getByRole("checkbox", { name: "Third account", exact: true }).click(),
        );
        yield* linkFailure.requested;
        expect(
          yield* browser.use("The checkbox is disabled while linking", () =>
            mailboxes.getByRole("checkbox", { name: "Third account", exact: true }).isDisabled(),
          ),
        ).toBe(true);
        yield* linkFailure.release;
        yield* failureShown("A failed link is reported in place", "Can’t reach the server");
        yield* shows("mailboxes", "A failed link keeps the current links", [
          ["First account", true],
          ["Second account", true],
          ["Third account", false],
        ]);
        expect(yield* links).toEqual(
          pairs(["primary", first], ["mailboxes", first], ["mailboxes", second]),
        );
        yield* browser.checkpoint("Failed link can be retried");
        const linked = yield* browser.use("Retry linking the same account", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "PUT" &&
                new URL(response.url()).pathname.endsWith(`/mailboxes/${third}`),
            ),
            mailboxes.getByRole("checkbox", { name: "Third account", exact: true }).click(),
          ]).then(([response]) => response.status()),
        );
        expect(linked).toBe(200);
        const allMailboxes = [
          ["First account", true],
          ["Second account", true],
          ["Third account", true],
        ] as const;
        yield* shows("mailboxes", "The linked account is checked", allMailboxes);
        yield* shows("primary", "The plain requirement keeps its own account", [
          ["First account", true],
          ["Second account", false],
          ["Third account", false],
        ]);
        expect(yield* links).toEqual(
          pairs(
            ["primary", first],
            ["mailboxes", first],
            ["mailboxes", second],
            ["mailboxes", third],
          ),
        );
        expect(
          yield* browser.use("Still on this app", (page) =>
            page.evaluate(() => location.pathname + location.search),
          ),
        ).toBe(url);
        yield* browser.use("Reload the Accounts tab", (page) => page.goto(url));
        yield* shows("mailboxes", "The link survives a reload", allMailboxes);
        // Every linked account's row has its menu, and each menu offers the account's details and
        // unlinking it.
        const linkedLabels = ["First account", "Second account", "Third account"];
        const menus: Array<readonly [number, number]> = [];
        for (const label of linkedLabels)
          menus.push(
            yield* browser.use(`Open the ${label} menu`, (page) =>
              mailboxes
                .getByRole("button", { name: `Manage ${label}`, exact: true })
                .click()
                .then(() => page.getByRole("menu").waitFor({ state: "visible" }))
                .then(() =>
                  Promise.all([
                    page.getByRole("menuitem", { name: "Edit details", exact: true }).count(),
                    page.getByRole("menuitem", { name: "Unlink", exact: true }).count(),
                  ]),
                )
                .then((counts) =>
                  page.keyboard
                    .press("Escape")
                    .then(() => page.getByRole("menu").waitFor({ state: "hidden" }))
                    .then(() => [counts[0], counts[1]] as const),
                ),
            ),
          );
        expect(menus, "Every linked mailbox offers its details and unlinking").toEqual([
          [1, 1],
          [1, 1],
          [1, 1],
        ]);

        // A failed unlink keeps the account linked.
        const unlinkFailure = yield* holdLink("DELETE", "mailboxes", second);
        yield* browser.use("Clear the second mailbox", () =>
          mailboxes.getByRole("checkbox", { name: "Second account", exact: true }).click(),
        );
        yield* unlinkFailure.requested;
        yield* unlinkFailure.release;
        yield* failureShown("A failed unlink is reported in place", "Can’t reach the server");
        yield* shows("mailboxes", "A failed unlink keeps the account linked", allMailboxes);
        expect(yield* links).toEqual(
          pairs(
            ["primary", first],
            ["mailboxes", first],
            ["mailboxes", second],
            ["mailboxes", third],
          ),
        );

        // A failed refresh keeps the accounts on the page.
        const refresh = yield* holdQuery(
          [actors.organization.slug, actors.organization.id].map(
            (id) => `/api/organizations/${id}/apps/${app.id}`,
          ),
          "undeclared",
        );
        yield* refreshVisiblePage;
        yield* refresh.requested;
        yield* refresh.release;
        yield* failureShown("Refresh failure is reported", "Unable to complete this request");
        yield* shows("mailboxes", "A failed refresh keeps the accounts", allMailboxes);

        const unlinked = yield* browser.use("Retry clearing the second mailbox", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "DELETE" &&
                new URL(response.url()).pathname.endsWith(`/mailboxes/${second}`),
            ),
            mailboxes.getByRole("checkbox", { name: "Second account", exact: true }).click(),
          ]).then(([response]) => response.status()),
        );
        expect(unlinked).toBe(200);
        const unused = yield* browser.use("Find the unused account prompt", (page) =>
          Promise.resolve(page.getByRole("dialog", { name: "Delete unused account?" })),
        );
        yield* browser.use("No app uses the unlinked account, so deletion is offered", () =>
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
        yield* shows("mailboxes", "The unlinked account is cleared", [
          ["First account", true],
          ["Second account", false],
          ["Third account", true],
        ]);
        expect(yield* links).toEqual(
          pairs(["primary", first], ["mailboxes", first], ["mailboxes", third]),
        );
        for (const account of accounts)
          expect(
            (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account}`)).status,
          ).toBe(200);

        // Connecting a new account from the app saves it and links it in one step.
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
            nameConnectedAccount(page, "Fourth account"),
          );
        });
        const connected = yield* accountLinks(actors.owner, appPath);
        const fourth = connected.find(
          ([requirement, id]) => requirement === "mailboxes" && !accounts.includes(id),
        )?.[1];
        if (fourth === undefined) return yield* Effect.die("The new mailbox was not linked");
        accounts.push(fourth);
        expect(yield* links).toEqual(
          pairs(
            ["primary", first],
            ["mailboxes", first],
            ["mailboxes", third],
            ["mailboxes", fourth],
          ),
        );
        yield* shows("mailboxes", "The new account is linked to the requirement it was for", [
          ["First account", true],
          ["Fourth account", true],
          ["Second account", false],
          ["Third account", true],
        ]);
        yield* shows("primary", "The new account is offered to the other requirement", [
          ["First account", true],
          ["Fourth account", false],
          ["Second account", false],
          ["Third account", false],
        ]);
        yield* browser.checkpoint("New account connected and linked");
        yield* browser.use("Clear the new mailbox", () =>
          mailboxes.getByRole("checkbox", { name: "Fourth account", exact: true }).click(),
        );
        yield* browser.use("Unlinking its last use offers deletion", () =>
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
        expect(inventory.accounts.map((account) => account.id)).not.toContain(fourth);
        expect(yield* links).toEqual(
          pairs(["primary", first], ["mailboxes", first], ["mailboxes", third]),
        );
        yield* shows("mailboxes", "The deleted account is no longer listed", [
          ["First account", true],
          ["Second account", false],
          ["Third account", true],
        ]);

        // The plain calendar requirement keeps one linked account: connecting Home after Work
        // replaced Work, which stays saved. Selecting Work's radio links it back in Home's place.
        const workCalendar = yield* connect("calendar", "Work calendar");
        const homeCalendar = yield* connect("calendar", "Home calendar");
        expect(yield* links).toEqual(
          pairs(
            ["primary", first],
            ["mailboxes", first],
            ["mailboxes", third],
            ["calendar", homeCalendar],
          ),
        );
        const calendar = yield* browser.use("Find the calendar accounts", (page) =>
          Promise.resolve(
            page.getByRole("region", { name: "Calendar fixture (calendar)", exact: true }),
          ),
        );
        yield* browser.use("Reload the Accounts tab for the calendar link", (page) =>
          page.goto(url),
        );
        yield* shows("calendar", "The calendar requirement selects its one account", [
          ["Home calendar", true],
          ["Work calendar", false],
        ]);
        expect(
          yield* browser.use("Choosing another account needs no Replace step", () =>
            Promise.all([
              calendar
                .getByText("The app uses this account when you use it.", { exact: true })
                .count(),
              calendar.getByRole("button", { name: "Replace", exact: true }).count(),
              calendar.getByRole("button", { name: "Connect new account", exact: true }).count(),
            ]),
          ),
        ).toEqual([1, 0, 1]);
        const replaced = yield* browser.use("Select Work calendar in place of Home", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "PUT" &&
                new URL(response.url()).pathname.endsWith(`/calendar/${workCalendar}`),
            ),
            calendar.getByRole("radio", { name: "Work calendar", exact: true }).click(),
          ]).then(([response]) => response.status()),
        );
        expect(replaced).toBe(200);
        yield* shows("calendar", "Work calendar replaces Home calendar", [
          ["Home calendar", false],
          ["Work calendar", true],
        ]);
        expect(yield* links).toEqual(
          pairs(
            ["primary", first],
            ["mailboxes", first],
            ["mailboxes", third],
            ["calendar", workCalendar],
          ),
        );
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${homeCalendar}`)).status,
          "the replaced account stays saved",
        ).toBe(200);
        yield* browser.checkpoint("A plain requirement's account replaced in place");
        yield* browser.use("Use the accounts at phone width", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("App accounts at phone width");
        expect(
          yield* browser.use("No horizontal overflow", (page) =>
            page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ),
        ).toBe(true);
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${appPath}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${appPath}/access`, {
            revision: access.revision,
            audience: { kind: "private" },
          })).status,
        ).toBe(200);
        yield* browser.login(actors.admin);
        yield* browser.use("An administrator opens the private app's accounts", (page) =>
          page.goto(url),
        );
        yield* browser.use("The Accounts tab explains the missing access", (page) =>
          page.getByText("This app is not shared with you.", { exact: false }).waitFor(),
        );
        expect(
          yield* browser.use("Users who cannot use the app get no account controls", (page) =>
            Promise.all([
              page.getByRole("radio").count(),
              page.getByRole("checkbox").count(),
              page.getByRole("button", { name: /^Manage / }).count(),
              page.getByRole("button", { name: "Connect new account", exact: true }).count(),
            ]),
          ),
        ).toEqual([0, 0, 0, 0]);
        yield* browser.checkpoint("Accounts without permission to use the app");

        // Deleting a linked account drops its links and keeps the other links; deleting the last
        // account of a requirement leaves it none.
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${third}`)).status,
        ).toBe(200);
        expect(yield* links).toEqual(
          pairs(["primary", first], ["mailboxes", first], ["calendar", workCalendar]),
        );
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${first}`)).status,
        ).toBe(200);
        expect(yield* links).toEqual(pairs(["calendar", workCalendar]));
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
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));`,
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
        // Without a registered client, administrators are offered registration before entering one.
        yield* browser.use("Administrators are offered client registration", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Register OAuth client", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Enter client details instead", enterClientDetails);
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
            })),
          ),
        ).toEqual({
          path: `/org/${actors.organization.slug}/apps/${app.id}`,
          view: "accounts",
        });

        yield* browser.use("The next attempt again offers registration first", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Register OAuth client", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Enter client details for the next attempt", enterClientDetails);
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
