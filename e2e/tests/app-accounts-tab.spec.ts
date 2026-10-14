/**
 * The Accounts tab in the hosted dashboard: one component lists App accounts, linked for everyone,
 * and Your accounts, linked for the caller. People who can edit the app choose its accounts with a
 * radio for a plain requirement, checkboxes for a many() requirement, and "Connect new account"
 * last; everyone else sees the App accounts greyed out and read-only. App schedules are marked as
 * the app's and only editors change them, and a call needing an app account that must reconnect
 * tells the caller someone who can edit the app must reconnect it.
 */
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

/**
 * Datadog is the app's own account; Mail each member's, where many() needs none linked. The `who`
 * tool reports the linked Datadog account, and `report` runs as the app on its app schedule.
 */
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

/** Deploy `content` as the owner and let everyone in the organization use the app. */
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
    // The app goes first: an account linked to it for everyone cannot be deleted.
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
    /** Start the owner's connection for a requirement; completing it links the account there. */
    const startConnection = (requirement: string, scope: LinkScope = "app") =>
      Effect.gen(function* () {
        const connection = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, scope, requirement),
          { destination: { kind: "personal" } },
        );
        expect(connection.status, JSON.stringify(connection.body)).toBe(200);
        return (yield* body(Resource, connection)).id;
      });
    /** Connect a key account for a requirement as the owner, which links it there. */
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
    /** The app's `(requirement, account)` links in one scope, as the owner lists them. */
    const links = (scope: LinkScope = "app") => accountLinks(actors.owner, path, scope);
    /** Link or unlink one of the app's own accounts as `actor`: the response, for refusals. */
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

/** The app's own requirements in the Accounts tab. */
const appSection = (page: Page) => page.getByRole("region", { name: "App accounts", exact: true });
/** The caller's own requirements in the Accounts tab. */
const yourSection = (page: Page) =>
  page.getByRole("region", { name: "Your accounts", exact: true });
/** Datadog's requirement in the App accounts section; the app has two requirements. */
const datadogSection = (page: Page) =>
  appSection(page).getByRole("region", { name: "Datadog (datadog)", exact: true });
/** Mail's requirement in the Your accounts section. */
const mailSection = (page: Page) =>
  yourSection(page).getByRole("region", { name: "Mail (mail)", exact: true });
/** The schedule row of the app's `report` schedule. */
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
        // Connecting for the plain app requirement links each new account, replacing the last.
        const team = yield* fixture.connect("datadog", "Team Datadog");
        const backup = yield* fixture.connect("datadog", "Backup Datadog");
        expect(yield* links()).toEqual([["datadog", backup]]);
        // Connecting for the many() user requirement adds each account.
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
        // The plain requirement lists every Datadog account the owner can use as radios, the
        // linked one selected, then the connect row.
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
        // The many() requirement lists the owner's Mail accounts as checkboxes, both linked.
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

        // Selecting Team Datadog links it for everyone, replacing Backup Datadog.
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

        // Clearing a checkbox unlinks that account from the many() requirement; checking it again
        // links it back.
        yield* browser.use("Clear Home mail", (page) =>
          mailSection(page).getByRole("checkbox", { name: "Home mail", exact: true }).click(),
        );
        // No app uses Home mail now; keeping it leaves it saved.
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
        expect(yield* links()).toEqual([]);
        // Unlinking keeps the account saved; the app's calls have no Datadog account now.
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
        // The member sees the requirement, the linked account's name and its selection, greyed
        // out and read-only.
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

        // The member uses the linked account through the app and can list the app links, but
        // cannot read a requirement's choices or change them.
        const called = yield* call(actors.member, "who");
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(yield* body(Schema.Json, called)).toBe(team);
        expect(yield* accountLinks(actors.member, path, "app")).toEqual([["datadog", team]]);
        const refusals = yield* Effect.all([
          fixture.api.request(actors.member, "GET", requirementPath(path, "app", "datadog")),
          appLink(actors.member, "DELETE", "datadog", team),
          appLink(actors.member, "PUT", "datadog", team),
          fixture.api.request(actors.member, "POST", connectionsPath(path, "app", "datadog"), {
            destination: { kind: "personal" },
          }),
        ]);
        expect(
          refusals.map((response) => response.status),
          JSON.stringify(refusals.map((response) => response.body)),
        ).toEqual([403, 403, 403, 403]);
        expect(yield* links()).toEqual([["datadog", team]]);
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
        /** The row's state, its buttons and whether each is enabled, and any approval choice. */
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

        // A member sees the paused app schedule with its control disabled, and cannot enable it.
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

        // A manager enables it from the tab, with no approval choice.
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

        // The member sees it enabled, still without controls or an approval choice.
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

        // The manager pauses it again.
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
        // Tokens issued inside the host's renewal window renew on every use.
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

        // The owner, who can edit the app, connects its account through the service's sign-in.
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
        // Linking makes the account the app's webhook source in the background, which resolves,
        // and so may renew, it. Let that finish so the renewal below belongs to the member's call.
        yield* settleWebhookSources(actors.owner, path, (sources) =>
          sources.some((source) => source.account === account && source.status !== "pending"),
        );
        const working = yield* call(actors.member, "who");
        expect(working.status, JSON.stringify(working.body)).toBe(200);

        // The member has the tool open when the service ends the grant.
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
        // The API names the app requirement too.
        const refused = yield* call(actors.member, "who");
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(
          yield* body(
            Schema.Struct({ _tag: Schema.String, appRequirement: Schema.String }),
            refused,
          ),
        ).toEqual({ _tag: "OAuthReconnectRequired", appRequirement: "service" });

        // The member's Accounts tab offers no reconnect either.
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

        // The owner is told the linked account needs sign-in and can reconnect it.
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
