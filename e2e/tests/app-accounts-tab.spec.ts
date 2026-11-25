import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import {
  accountLinks,
  connectionsPath,
  requirementPath,
  type LinkScope,
} from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Access } from "../support/hosted-app-accounts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { settleWebhookSources } from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";

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
const Failure = Schema.Struct({ _tag: Schema.String });
const Settings = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    actor: Schema.NullOr(Schema.String),
    enabled: Schema.Boolean,
  }),
);
const readOnly = "Only people who can edit this app can change these accounts.";

const sharedApp = (name: string, content: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content }, appsManifest],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed),
      path = `${prefix}/apps/${app.id}`;
    const accounts: string[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* api.request(actors.owner, "DELETE", path);
        for (const account of accounts)
          yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
      }).pipe(Effect.orDie),
    );
    const access = yield* body(Access, yield* api.request(actors.owner, "GET", `${path}/access`));
    expect(
      (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
        revision: access.revision,
        audience: { kind: "everyone" },
      })).status,
    ).toBe(200);
    const startConnection = (requirement: string, scope: LinkScope = "app") =>
      Effect.gen(function* () {
        const connection = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, scope, requirement),
          {},
        );
        expect(connection.status, JSON.stringify(connection.body)).toBe(200);
        return (yield* body(Resource, connection)).id;
      });
    const connect = (requirement: string, label: string, scope: LinkScope = "app") =>
      Effect.gen(function* () {
        const connection = yield* startConnection(requirement, scope);
        const response = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection}/submit`,
          { method: "key", label, fields: { token: `synthetic-${randomUUID()}` } },
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const account = (yield* body(Resource, response)).id;
        accounts.push(account);
        return account;
      });
    const links = (scope: LinkScope = "app") => accountLinks(actors.owner, path, scope);
    const appLink = (
      actor: Session,
      method: "PUT" | "DELETE",
      requirement: string,
      account: string,
    ) =>
      api.request(
        actor,
        method,
        `${requirementPath(path, "app", requirement)}/${encodeURIComponent(account)}`,
      );
    const call = (actor: Session, tool: string) =>
      api.request(actor, "POST", `${path}/tools/call`, { tool, kind: "query", input: {} });
    return {
      api,
      actors,
      prefix,
      app,
      path,
      url: `/org/${actors.organization.slug}/apps/${app.id}`,
      accounts,
      startConnection,
      connect,
      links,
      appLink,
      call,
    };
  });

const appSection = (page: Page) => page.getByRole("region", { name: "App accounts", exact: true });
const yourSection = (page: Page) =>
  page.getByRole("region", { name: "Your accounts", exact: true });
const datadogSection = (page: Page) =>
  appSection(page).getByRole("region", { name: "Datadog (datadog)", exact: true });
const mailSection = (page: Page) =>
  yourSection(page).getByRole("region", { name: "Mail (mail)", exact: true });
const reportRow = (page: Page) => page.locator('[aria-label="report"]');

layer(HostedLive, { excludeTestServices: true })("Hosted Accounts tab", (it) => {
  it.effect(scenarios.hostedAppAccountsManagerBrowser.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          evidence = yield* Evidence;
        const fixture = yield* sharedApp("Team report", source);
        const { actors, url, links, call } = fixture;
        const team = yield* fixture.connect("datadog", "Team Datadog");
        const backup = yield* fixture.connect("datadog", "Backup Datadog");
        expect(yield* links()).toEqual([["datadog", backup]]);
        const work = yield* fixture.connect("mail", "Work mail", "user");
        const home = yield* fixture.connect("mail", "Home mail", "user");
        expect(yield* links("user")).toEqual([
          ["mail", work],
          ["mail", home],
        ]);

        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's accounts", (page) => page.goto(`${url}?view=accounts`));
        yield* browser.use("The App accounts section is linked for everyone", (page) =>
          appSection(page).getByText("Linked for everyone", { exact: true }).waitFor(),
        );
        yield* browser.use("Your accounts are linked for you", (page) =>
          yourSection(page).getByText("Linked for you", { exact: true }).waitFor(),
        );
        yield* browser.use("Backup Datadog is the selected radio", (page) =>
          datadogSection(page)
            .getByRole("radio", { name: "Backup Datadog", checked: true, exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("Read the App accounts controls", (page) =>
            Promise.all([
              datadogSection(page)
                .getByRole("radio")
                .evaluateAll((elements) =>
                  elements.map((element) => [
                    element.getAttribute("aria-label"),
                    element.getAttribute("aria-checked"),
                  ]),
                ),
              datadogSection(page)
                .getByRole("button", { name: "Connect new account", exact: true })
                .count(),
              page.getByRole("button", { name: "Replace", exact: true }).count(),
              appSection(page).getAttribute("data-read-only"),
            ]),
          ),
        ).toEqual([
          [
            ["Backup Datadog", "true"],
            ["Team Datadog", "false"],
          ],
          1,
          0,
          "false",
        ]);
        expect(
          yield* browser.use("Read Your accounts controls", (page) =>
            mailSection(page)
              .getByRole("checkbox")
              .evaluateAll((elements) =>
                elements.map((element) => [
                  element.getAttribute("aria-label"),
                  element.getAttribute("aria-checked"),
                ]),
              ),
          ),
        ).toEqual([
          ["Home mail", "true"],
          ["Work mail", "true"],
        ]);
        yield* browser.checkpoint("Manager's Accounts tab");
        const screenshot = yield* browser.use("Capture the manager's accounts", (page) =>
          page.screenshot({ fullPage: true }),
        );
        yield* evidence.attach("manager-accounts.png", "image/png", screenshot);

        yield* browser.use("Select Team Datadog", (page) =>
          datadogSection(page).getByRole("radio", { name: "Team Datadog", exact: true }).click(),
        );
        yield* browser.use("Team Datadog is selected", (page) =>
          datadogSection(page)
            .getByRole("radio", { name: "Team Datadog", checked: true, exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("Backup Datadog is no longer selected", (page) =>
            datadogSection(page)
              .getByRole("radio", { name: "Backup Datadog", exact: true })
              .getAttribute("aria-checked"),
          ),
        ).toBe("false");
        expect(yield* links()).toEqual([["datadog", team]]);
        const called = yield* call(actors.member, "who");
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(yield* body(Schema.Json, called)).toBe(team);

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
        expect(yield* links("user")).toEqual([["mail", work]]);
        yield* browser.use("Check Home mail again", (page) =>
          mailSection(page).getByRole("checkbox", { name: "Home mail", exact: true }).click(),
        );
        yield* browser.use("Home mail is checked", (page) =>
          mailSection(page)
            .getByRole("checkbox", { name: "Home mail", checked: true, exact: true })
            .waitFor(),
        );
        expect(yield* links("user")).toEqual([
          ["mail", work],
          ["mail", home],
        ]);

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
        expect(yield* links()).toEqual([]);
        const saved = yield* fixture.api.request(
          actors.owner,
          "GET",
          `${fixture.prefix}/accounts/${team}`,
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const refused = yield* call(actors.member, "who");
        expect(refused.status, JSON.stringify(refused.body)).not.toBe(200);
        expect((yield* body(Failure, refused))._tag).toBe("AccountRequired");
      }),
    ),
  );

  it.effect(scenarios.hostedAppAccountsMemberBrowser.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          evidence = yield* Evidence;
        const fixture = yield* sharedApp("Team report", source);
        const { actors, url, links, appLink, call, path } = fixture;
        const team = yield* fixture.connect("datadog", "Team Datadog");
        expect(yield* links()).toEqual([["datadog", team]]);

        yield* browser.login(actors.member);
        yield* browser.use("Open the member's accounts", (page) =>
          page.goto(`${url}?view=accounts`),
        );
        yield* browser.use("The App accounts section says who can change it", (page) =>
          appSection(page).getByText(readOnly, { exact: true }).waitFor(),
        );
        yield* browser.use("Team Datadog is shown selected and disabled", (page) =>
          datadogSection(page)
            .getByRole("radio", {
              name: "Team Datadog",
              checked: true,
              disabled: true,
              exact: true,
            })
            .waitFor(),
        );
        yield* browser.use("The member's own requirement is theirs to link", (page) =>
          yourSection(page)
            .getByRole("button", { name: "Connect new account", exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("The App accounts section offers no change", (page) =>
            Promise.all([
              appSection(page).getAttribute("data-read-only"),
              appSection(page).getByRole("button").count(),
              appSection(page).getByRole("radio", { disabled: false }).count(),
              page.getByRole("button", { name: /^(Replace|Manage Team Datadog)/ }).count(),
            ]),
          ),
        ).toEqual(["true", 0, 0, 0]);
        yield* browser.checkpoint("Member's read-only App accounts");
        const screenshot = yield* browser.use("Capture the member's accounts", (page) =>
          page.screenshot({ fullPage: true }),
        );
        yield* evidence.attach("member-app-accounts.png", "image/png", screenshot);

        const called = yield* call(actors.member, "who");
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(yield* body(Schema.Json, called)).toBe(team);
        expect(yield* accountLinks(actors.member, path, "app")).toEqual([["datadog", team]]);
        const refusals = yield* Effect.all([
          fixture.api.request(actors.member, "GET", requirementPath(path, "app", "datadog")),
          appLink(actors.member, "DELETE", "datadog", team),
          appLink(actors.member, "PUT", "datadog", team),
          fixture.api.request(actors.member, "POST", connectionsPath(path, "app", "datadog"), {}),
        ]);
        expect(
          refusals.map((response) => response.status),
          JSON.stringify(refusals.map((response) => response.body)),
        ).toEqual([403, 403, 403, 403]);
        expect(yield* links()).toEqual([["datadog", team]]);
      }),
    ),
  );

  it.effect(scenarios.hostedAppAccountListedBrowser.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          evidence = yield* Evidence;
        const fixture = yield* sharedApp("Team report", source);
        const { actors, app } = fixture;
        const label = `Team Datadog ${randomUUID().slice(0, 8)}`;
        const team = yield* fixture.connect("datadog", label);
        expect(yield* fixture.links()).toEqual([["datadog", team]]);
        const card = (page: Page) =>
          page.getByRole("link", { name: `Open ${app.name}`, exact: true });

        yield* browser.login(actors.member);
        yield* browser.use("Open the member's apps", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("The card names the app's account", (page) =>
          card(page).getByText(label, { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("The card says no account is missing", (page) =>
            card(page)
              .getByText(/^(No accounts linked|Needs account)$/)
              .count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Member's app card with the app's account");
        yield* evidence.attach(
          "member-app-card.png",
          "image/png",
          yield* browser.use("Capture the member's apps", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );

        yield* browser.login(actors.owner);
        yield* browser.use("Open the owner's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        const row = (page: Page) => page.locator(".inventory-row").filter({ hasText: label });
        yield* browser.use("The account's row links to the app", (page) =>
          row(page).getByRole("link", { name: app.name }).waitFor(),
        );
        expect(
          yield* browser.use("The row does not say No apps", (page) =>
            row(page).getByText("No apps", { exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Owner's account row with the app");
        yield* evidence.attach(
          "owner-account-row.png",
          "image/png",
          yield* browser.use("Capture the owner's accounts", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );
      }),
    ),
  );

  it.effect(scenarios.hostedAppSchedulesBrowser.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          evidence = yield* Evidence;
        const fixture = yield* sharedApp("Team report", source);
        const { api, actors, url, path } = fixture;
        yield* fixture.connect("datadog", "Team Datadog");
        const appSchedule = api.request(actors.owner, "GET", `${path}/schedules`).pipe(
          Effect.flatMap((response) => body(Settings, response)),
          Effect.map((rows) => rows.filter((row) => row.name === "report")),
        );
        const configure = (actor: Session, enabled: boolean) =>
          api.request(actor, "PATCH", `${path}/schedules/report`, { scope: "app", enabled });
        const openSchedules = (who: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Open ${who}'s schedules`, (page) =>
              page.goto(`${url}?view=schedules`),
            );
            yield* browser.use("The tab says app schedules run as the app", (page) =>
              page
                .getByText("App schedules run as the app, with the accounts linked for everyone.", {
                  exact: true,
                })
                .waitFor(),
            );
            yield* browser.use("The report schedule is the app's", (page) =>
              reportRow(page).getByText("App schedule", { exact: true }).waitFor(),
            );
          });
        const rowControls = (state: string) =>
          Effect.gen(function* () {
            yield* browser.use(`The row is ${state}`, (page) =>
              reportRow(page).getByText(state, { exact: true }).waitFor(),
            );
            const [buttons, approvals, yours] = yield* browser.use(
              "Read the row's controls",
              (page) =>
                Promise.all([
                  reportRow(page)
                    .getByRole("button")
                    .evaluateAll((elements) =>
                      elements.map((element) => [
                        element.textContent?.trim(),
                        !(element instanceof HTMLButtonElement && element.disabled),
                      ]),
                    ),
                  page.getByRole("combobox", { name: "Approvals for report" }).count(),
                  reportRow(page).getByText("Your schedule", { exact: true }).count(),
                ]),
            );
            return { buttons, approvals, yours };
          });

        yield* browser.login(actors.member);
        yield* openSchedules("the member");
        expect(yield* rowControls("Paused")).toEqual({
          buttons: [["Enable", false]],
          approvals: 0,
          yours: 0,
        });
        yield* browser.checkpoint("Member sees the paused app schedule");
        const refused = yield* configure(actors.member, true);
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(yield* appSchedule).toEqual([]);

        yield* browser.login(actors.owner);
        yield* openSchedules("the manager");
        expect(yield* rowControls("Paused")).toEqual({
          buttons: [["Enable", true]],
          approvals: 0,
          yours: 0,
        });
        yield* browser.use("Enable the app schedule", (page) =>
          reportRow(page).getByRole("button", { name: "Enable", exact: true }).click(),
        );
        expect(yield* rowControls("Enabled")).toEqual({
          buttons: [
            ["Pause", true],
            ["Run now", true],
            ["Remove", true],
          ],
          approvals: 0,
          yours: 0,
        });
        expect(yield* appSchedule).toMatchObject([{ actor: null, enabled: true }]);

        yield* browser.login(actors.member);
        yield* openSchedules("the member");
        expect(yield* rowControls("Enabled")).toEqual({
          buttons: [["Pause", false]],
          approvals: 0,
          yours: 0,
        });
        const screenshot = yield* browser.use("Capture the member's schedules", (page) =>
          page.screenshot(),
        );
        yield* evidence.attach("member-app-schedule.png", "image/png", screenshot);
        const pauseRefused = yield* configure(actors.member, false);
        expect(pauseRefused.status, JSON.stringify(pauseRefused.body)).toBe(403);
        expect(yield* appSchedule).toMatchObject([{ actor: null, enabled: true }]);

        yield* browser.login(actors.owner);
        yield* openSchedules("the manager");
        yield* browser.use("Pause the app schedule", (page) =>
          reportRow(page).getByRole("button", { name: "Pause", exact: true }).click(),
        );
        yield* rowControls("Paused");
        expect(yield* appSchedule).toMatchObject([{ actor: null, enabled: false }]);
      }),
    ),
  );

  it.effect(scenarios.hostedAppAccountReconnectBrowser.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          evidence = yield* Evidence,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
        const provider = `Reconnect service ${randomUUID().slice(0, 8)}`;
        const fixture = yield* sharedApp(
          "Reconnect message",
          `import { defineApp, defineProvider, oauth2, query, object, router, type QueryContext } from "apps";
const service = defineProvider({ name: ${JSON.stringify(provider)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
const requirements = { app: { accounts: { service } } };
const who = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => {
  const response = await ctx.fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { method: "POST", headers: { authorization: "Bearer " + ctx.app.accounts.service.fields.access_token } });
  return await response.json();
});
export default defineApp(requirements, async () => ({ tools: router({ who }) }));`,
        );
        const { api, actors, prefix, path, url, links, call } = fixture;

        const connection = yield* fixture.startConnection("service");
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection}/oauth/start`,
          { method: "oauth", label: "Team service" },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const { authorizationUrl } = yield* body(
          Schema.Struct({ authorizationUrl: Schema.String }),
          started,
        );
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
            expect(consent.status).toBe(302);
            const location = consent.headers.location;
            if (location === undefined)
              return yield* Effect.die("Issuer did not return a callback");
            return location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection}/oauth/complete`,
          { callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = (yield* body(Resource, completed)).id;
        fixture.accounts.push(account);
        expect(yield* links()).toEqual([["service", account]]);
        yield* settleWebhookSources(actors.owner, path, (sources) =>
          sources.some((source) => source.account === account && source.status !== "pending"),
        );
        const working = yield* call(actors.member, "who");
        expect(working.status, JSON.stringify(working.body)).toBe(200);

        yield* browser.login(actors.member);
        yield* browser.use("Open the member's tool", (page) =>
          page.goto(`${url}?view=tools&tool=who`),
        );
        yield* browser.use("The tool is ready to run", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).waitFor(),
        );
        yield* issuer.configure({ tokenError: { status: 400, body: { error: "invalid_grant" } } });
        yield* browser.use("Run the tool", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).click(),
        );
        yield* browser.use(
          "The member is told someone who can edit the app must reconnect its account",
          (page) =>
            page
              .getByText(
                "The app’s “service” account needs to sign in again. The app uses it for everyone, so someone who can edit this app must reconnect it from the app’s Accounts tab.",
                { exact: true },
              )
              .waitFor(),
        );
        expect(
          yield* browser.use("The member is offered no reconnect", (page) =>
            page
              .getByRole("main")
              .getByRole("button", { name: /reconnect|sign in/i })
              .count(),
          ),
        ).toBe(0);
        const message = yield* browser.use("Capture the reconnect message", (page) =>
          page.screenshot(),
        );
        yield* evidence.attach("member-reconnect-message.png", "image/png", message);
        const refused = yield* call(actors.member, "who");
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(
          yield* body(
            Schema.Struct({ _tag: Schema.String, appRequirement: Schema.String }),
            refused,
          ),
        ).toEqual({ _tag: "OAuthReconnectRequired", appRequirement: "service" });

        yield* browser.use("Open the member's accounts", (page) =>
          page.goto(`${url}?view=accounts`),
        );
        yield* browser.use("The App accounts section is read-only", (page) =>
          appSection(page).getByText(readOnly, { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("The member's section has no reconnect", (page) =>
            appSection(page).getByRole("button").count(),
          ),
        ).toBe(0);

        yield* browser.login(actors.owner);
        yield* browser.use("Open the manager's accounts", (page) =>
          page.goto(`${url}?view=accounts`),
        );
        const linkedRow = (page: Page) =>
          appSection(page)
            .getByRole("list", { name: `${provider} accounts`, exact: true })
            .getByRole("listitem")
            .filter({ hasText: "Team service" });
        yield* browser.use("The manager is told the linked account needs sign-in", (page) =>
          linkedRow(page).getByText("Needs sign-in").waitFor(),
        );
        yield* browser.use("The manager is offered Reconnect beside it", (page) =>
          linkedRow(page).getByRole("button", { name: "Reconnect", exact: true }).waitFor(),
        );
        const needsSignIn = yield* browser.use("Capture the manager's linked account", (page) =>
          page.screenshot(),
        );
        yield* evidence.attach("manager-linked-reconnect.png", "image/png", needsSignIn);
        yield* browser.use("Open Team service's actions", (page) =>
          appSection(page)
            .getByRole("list", { name: `${provider} accounts`, exact: true })
            .getByRole("button", { name: "Manage Team service", exact: true })
            .click(),
        );
        yield* browser.use("The manager is offered Reconnect", (page) =>
          page.getByRole("menuitem", { name: "Reconnect", exact: true }).waitFor(),
        );
        const manager = yield* browser.use("Capture the manager's accounts", (page) =>
          page.screenshot(),
        );
        yield* evidence.attach("manager-reconnect.png", "image/png", manager);
        yield* issuer.configure({ tokenError: null });
      }),
    ),
  );
});
