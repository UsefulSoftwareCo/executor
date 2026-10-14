/**
 * Local's Accounts tab: the App accounts section picks the app's own account with a radio and
 * unlinks it, keeping it saved, Your accounts clears and checks a many() account, and the
 * Schedules tab controls the app schedule, which has no approval choice.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Api, body } from "../support/api.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import {
  linkLocal,
  localAccountLinks,
  localAgent,
  pairLocalBrowser,
} from "../support/local-links.ts";
import { scenarios } from "../test-plan.ts";

/** Datadog is the app's own account and Mail the caller's; `report` runs on the app schedule. */
const source = `import { defineApp, defineProvider, secrets, query, mutation, appInterval, object, string, router, type QueryContext } from "apps";
const key = secrets({ label: "Key", fields: object({ token: string() }) });
const datadog = defineProvider({ name: "Datadog", auth: { key } });
const mail = defineProvider({ name: "Mail", auth: { key } });
const requirements = { app: { accounts: { datadog } }, user: { accounts: { mail: mail.many() } } };
const who = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ctx.app.accounts.datadog.id);
const report = mutation({ input: object({}) }, async () => "reported");
export default defineApp(requirements, async () => ({
  tools: router({ who, report }),
  schedules: { report: appInterval({ minutes: 1 }, report, {}) },
}));`;
const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Settings = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    actor: Schema.NullOr(Schema.String),
    enabled: Schema.Boolean,
  }),
);

const appSection = (page: Page) => page.getByRole("region", { name: "App accounts", exact: true });
const datadogSection = (page: Page) =>
  appSection(page).getByRole("region", { name: "Datadog (datadog)", exact: true });
const mailSection = (page: Page) =>
  page
    .getByRole("region", { name: "Your accounts", exact: true })
    .getByRole("region", { name: "Mail (mail)", exact: true });
const reportRow = (page: Page) => page.locator('[aria-label="report"]');

layer(TestLive, { excludeTestServices: true })("Local Accounts tab", (it) => {
  it.effect(scenarios.localAppAccountsBrowser.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const { agent, headers } = yield* localAgent;
        const { app } = yield* body(
          Deployed,
          yield* api.request(agent, "POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Team report ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          }),
        );
        const owned = [`/v1/apps/${app.id}`];
        // The app goes first: an account linked to it for everyone cannot be deleted.
        yield* Effect.addFinalizer(() =>
          Effect.forEach(owned, (path) => api.request(agent, "DELETE", path)).pipe(Effect.orDie),
        );
        const appPath = `/dashboard/api/apps/${app.id}`;
        const appSchedule = api.request(agent, "GET", `${appPath}/schedules`).pipe(
          Effect.flatMap((response) => body(Settings, response)),
          Effect.map((rows) => rows.filter((row) => row.name === "report")),
        );
        /** Connect a key account for one of the app's requirements, which links it there. */
        const connect = (requirement: string, label: string) =>
          Effect.gen(function* () {
            const account = (yield* connectLocalAccount(
              agent,
              {
                app: app.id,
                requirement,
                method: "key",
                label,
                fields: { token: `synthetic-${randomUUID()}` },
              },
              headers,
            )).id;
            owned.push(`/v1/accounts/${account}`);
            return account;
          });
        // Connecting for the plain app requirement links each new account, replacing the last;
        // for the many() user requirement it adds each.
        const team = yield* connect("datadog", "Team Datadog");
        const backup = yield* connect("datadog", "Backup Datadog");
        const work = yield* connect("mail", "Work mail");
        const home = yield* connect("mail", "Home mail");
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([["datadog", backup]]);
        expect(yield* localAccountLinks(agent, app.id, "user")).toEqual([
          ["mail", work],
          ["mail", home],
        ]);

        yield* pairLocalBrowser(agent);
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Backup Datadog is the selected radio", (page) =>
          datadogSection(page)
            .getByRole("radio", { name: "Backup Datadog", checked: true, exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("Read the Accounts tab's controls", (page) =>
            Promise.all([
              appSection(page).getByText("Linked for everyone", { exact: true }).count(),
              datadogSection(page)
                .getByRole("radio")
                .evaluateAll((elements) =>
                  elements.map((element) => [
                    element.getAttribute("aria-label"),
                    element.getAttribute("aria-checked"),
                  ]),
                ),
              mailSection(page)
                .getByRole("checkbox")
                .evaluateAll((elements) =>
                  elements.map((element) => [
                    element.getAttribute("aria-label"),
                    element.getAttribute("aria-checked"),
                  ]),
                ),
              page.getByRole("button", { name: "Connect new account", exact: true }).count(),
              page.getByRole("button", { name: "Replace", exact: true }).count(),
            ]),
          ),
        ).toEqual([
          1,
          [
            ["Backup Datadog", "true"],
            ["Team Datadog", "false"],
          ],
          [
            ["Home mail", "true"],
            ["Work mail", "true"],
          ],
          2,
          0,
        ]);
        const accountsShot = yield* browser.use("Capture the Accounts tab", (page) =>
          page.screenshot({ fullPage: true }),
        );
        yield* evidence.attach("local-accounts-tab.png", "image/png", accountsShot);

        // Selecting Team Datadog links it for every call, replacing Backup Datadog.
        yield* browser.use("Select Team Datadog", (page) =>
          datadogSection(page).getByRole("radio", { name: "Team Datadog", exact: true }).click(),
        );
        yield* browser.use("Team Datadog is selected", (page) =>
          datadogSection(page)
            .getByRole("radio", { name: "Team Datadog", checked: true, exact: true })
            .waitFor(),
        );
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([["datadog", team]]);

        // Clearing a checkbox unlinks the account; no app uses it now, and keeping it leaves it
        // saved. Checking it again links it back.
        yield* browser.use("Clear Home mail", (page) =>
          mailSection(page).getByRole("checkbox", { name: "Home mail", exact: true }).click(),
        );
        yield* browser.use("Keep the unused mail account", (page) =>
          page
            .getByRole("dialog", { name: "Delete unused account?" })
            .getByRole("button", { name: "Keep account", exact: true })
            .click(),
        );
        yield* browser.use("Home mail is cleared", (page) =>
          mailSection(page)
            .getByRole("checkbox", { name: "Home mail", checked: false, exact: true })
            .waitFor(),
        );
        expect(yield* localAccountLinks(agent, app.id, "user")).toEqual([["mail", work]]);
        yield* browser.use("Check Home mail again", (page) =>
          mailSection(page).getByRole("checkbox", { name: "Home mail", exact: true }).click(),
        );
        yield* browser.use("Home mail is checked", (page) =>
          mailSection(page)
            .getByRole("checkbox", { name: "Home mail", checked: true, exact: true })
            .waitFor(),
        );
        expect(yield* localAccountLinks(agent, app.id, "user")).toEqual([
          ["mail", work],
          ["mail", home],
        ]);

        // Unlinking the plain requirement's account from its menu leaves nothing selected.
        yield* browser.use("Open Team Datadog's actions", (page) =>
          datadogSection(page)
            .getByRole("button", { name: "Manage Team Datadog", exact: true })
            .click(),
        );
        yield* browser.use("Unlink Team Datadog", (page) =>
          page.getByRole("menuitem", { name: "Unlink", exact: true }).click(),
        );
        yield* browser.use("Keep the unused Datadog account", (page) =>
          page
            .getByRole("dialog", { name: "Delete unused account?" })
            .getByRole("button", { name: "Keep account", exact: true })
            .click(),
        );
        yield* browser.use("The section asks for an account again", (page) =>
          datadogSection(page).getByText("Link an account so the app can run.").waitFor(),
        );
        expect(
          yield* browser.use("No Datadog account is selected", (page) =>
            datadogSection(page).getByRole("radio", { checked: true }).count(),
          ),
        ).toBe(0);
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([]);
        const saved = yield* api.request(agent, "GET", `/v1/accounts/${team}`);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);

        // Linked again, the app schedule's declarations load in the Schedules tab.
        yield* linkLocal(agent, app.id, "datadog", team, "app");
        yield* browser.use("Open the app's schedules", (page) =>
          page.goto(`/apps/${app.id}?view=schedules`),
        );
        yield* browser.use("The tab says app schedules run as the app", (page) =>
          page
            .getByText("App schedules run as the app, with the accounts linked for everyone.", {
              exact: true,
            })
            .waitFor(),
        );
        const controls = (state: string) =>
          Effect.gen(function* () {
            yield* browser.use(`The app schedule is ${state}`, (page) =>
              reportRow(page).getByText(state, { exact: true }).waitFor(),
            );
            return yield* browser.use("Read the schedule's controls", (page) =>
              Promise.all([
                reportRow(page).getByText("App schedule", { exact: true }).count(),
                reportRow(page).getByRole("button").allInnerTexts(),
                page.getByRole("combobox", { name: "Approvals for report" }).count(),
              ]),
            );
          });
        expect(yield* controls("Paused")).toEqual([1, ["Enable"], 0]);
        yield* browser.use("Enable the app schedule", (page) =>
          reportRow(page).getByRole("button", { name: "Enable", exact: true }).click(),
        );
        expect(yield* controls("Enabled")).toEqual([1, ["Pause", "Run now", "Remove"], 0]);
        expect(yield* appSchedule).toMatchObject([{ actor: null, enabled: true }]);
        const scheduleShot = yield* browser.use("Capture the app schedule", (page) =>
          page.screenshot(),
        );
        yield* evidence.attach("local-app-schedule.png", "image/png", scheduleShot);
        yield* browser.use("Pause the app schedule", (page) =>
          reportRow(page).getByRole("button", { name: "Pause", exact: true }).click(),
        );
        yield* controls("Paused");
        expect(yield* appSchedule).toMatchObject([{ actor: null, enabled: false }]);
      }),
    ),
  );
});
