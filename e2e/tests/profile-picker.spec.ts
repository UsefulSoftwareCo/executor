import { saveAndDeploy } from "../support/app-authoring.ts";
/** Profile selection survives refresh and remains independent in each browser tab. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";
const Setup = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  accounts: Schema.Struct({ service: Schema.String, extra: Schema.Array(Schema.String) }),
});
const source = `import {defineApp,defineProvider,secrets,query,object,string} from "apps";
const service=defineProvider({name:"Inbox",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export const who=query({input:object({})},async ctx=>({context:{auth:"auth" in ctx,profile:"profile" in ctx},account:ctx.accounts.service.id,extra:ctx.accounts.extra.map(a=>a.id)}));
export default defineApp({accounts:{service,extra:service.many()}},{queries:{who}});`;
const profileFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    browser = yield* Browser;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const files = [
    { path: "index.ts", content: source },
    {
      path: "ui/index.html",
      content:
        '<!doctype html><html><head><title>Inbox</title></head><body><h1>Inbox identity</h1><pre id="identity"></pre><p role="status">Loading</p><script type="module" src="./main.ts"></script></body></html>',
    },
    {
      path: "ui/main.ts",
      content: `import {object,string,array,boolean} from "apps";import {createAppClient,queryReference} from "apps/client";import type {who} from "../index.ts";
const client=createAppClient();client.query(queryReference<typeof who>("who"),{},object({context:object({auth:boolean(),profile:boolean()}),account:string(),extra:array(string())})).then(value=>{document.querySelector("#identity").textContent=JSON.stringify(value);document.querySelector('[role="status"]').textContent="Ready";}).catch(()=>{document.querySelector('[role="status"]').textContent="Load failed";});`,
    },
  ];
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Inbox ${randomUUID().slice(0, 8)}`,
    files,
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(
      Schema.Struct({ ...App.fields, activeDeployment: Schema.String }),
      deployed,
    ),
    path = `${prefix}/apps/${app.id}`,
    url = `/org/${actors.organization.slug}/apps/${app.id}`;
  const revision = yield* body(
    Schema.Struct({ revision: Schema.String }),
    yield* api.request(actors.owner, "GET", `${path}/access`),
  );
  expect(
    (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
      revision: revision.revision,
      audience: { kind: "everyone" },
    })).status,
  ).toBe(200);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", path).pipe(Effect.asVoid, Effect.orDie),
  );
  return { api, actors, browser, prefix, files, app, path, url };
});

const seededProfileFixture = Effect.gen(function* () {
  const fixture = yield* profileFixture;
  const { api, actors, prefix, path } = fixture;
  const [first, second] = yield* Effect.forEach(
    ["Personal inbox", "Work inbox"],
    (name) =>
      Effect.gen(function* () {
        const profile = yield* body(
          Resource,
          yield* api.request(actors.member, "POST", `${path}/profiles`, {
            name,
            accounts: { extra: [] },
            idempotencyKey: name,
          }),
        );
        const connection = yield* body(
          Resource,
          yield* api.request(actors.member, "POST", `${path}/connections`, {
            profile: profile.id,
            requirement: "service",
            destination: { kind: "personal" },
          }),
        );
        const account = yield* api.request(
          actors.member,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          {
            method: "key",
            label: name,
            fields: { token: "synthetic-inbox-key" },
          },
        );
        expect(account.status).toBe(200);
        return yield* body(
          Setup,
          yield* api.request(actors.member, "GET", `${path}/profiles/${profile.id}`),
        );
      }),
    { concurrency: 2 },
  );
  if (!first || !second) return yield* Effect.die("Missing saved profiles");
  return { ...fixture, first, second };
});

layer(HostedLive, { excludeTestServices: true })("Profile picker", (it) => {
  it.effect(scenarios.profileCreation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, browser, path, url } = yield* profileFixture;
        yield* browser.login(actors.member);
        yield* browser.use("Open the shared inbox app", (page) => page.goto(`${url}?view=tools`));
        for (const label of ["Personal inbox", "Work inbox"]) {
          yield* browser.use("Open account management", (page) =>
            page
              .getByRole("navigation", { name: "App navigation", exact: true })
              .getByRole("link", { name: "Accounts", exact: true })
              .click(),
          );
          if (label === "Personal inbox") {
            yield* Effect.gen(function* () {
              expect(
                yield* browser.use("The first setup needs no selector", (page) =>
                  page.getByRole("button", { name: "Choose profile", exact: true }).count(),
                ),
              ).toBe(0);
            });
          } else {
            const [initial] = yield* body(
              Schema.Array(Setup),
              yield* api.request(actors.member, "GET", `${path}/profiles`),
            );
            if (!initial) return yield* Effect.die("Missing default setup");
            yield* Effect.gen(function* () {
              yield* browser.use("Cancel an unsaved setup", (page) =>
                page.getByRole("button", { name: "Create a profile", exact: true }).first().click(),
              );
              yield* browser.use("Cancel an unsaved setup", (page) =>
                page.getByRole("textbox", { name: "Name", exact: true }).fill("Cancelled draft"),
              );
              expect(
                yield* browser.use("Cancel an unsaved setup", (page) =>
                  page.getByRole("dialog").getByRole("combobox").count(),
                ),
              ).toBe(0);
              expect(
                yield* browser.use("Cancel an unsaved setup", (page) =>
                  page.getByRole("dialog").getByRole("checkbox").count(),
                ),
              ).toBe(0);
              yield* browser.use("Cancel an unsaved setup", (page) =>
                page.getByRole("button", { name: "Cancel", exact: true }).click(),
              );
            });
            expect(
              yield* body(
                Schema.Array(Setup),
                yield* api.request(actors.member, "GET", `${path}/profiles`),
              ),
            ).toHaveLength(1);
            yield* Effect.gen(function* () {
              yield* browser.use("Create a setup with only a name", (page) =>
                page.getByRole("button", { name: "Create a profile", exact: true }).first().click(),
              );
              yield* browser.use("Create a setup with only a name", (page) =>
                page.getByRole("textbox", { name: "Name", exact: true }).fill(label),
              );
              yield* browser.use("Create a setup with only a name", (page) =>
                page.getByRole("button", { name: "Create profile", exact: true }).click(),
              );
              yield* browser.use("Create a setup with only a name", (page) =>
                page.getByRole("dialog").waitFor({ state: "hidden" }),
              );
            });
            const [unchanged, added] = yield* body(
              Schema.Array(
                Schema.Struct({
                  ...Setup.fields,
                  accounts: Schema.Record(
                    Schema.String,
                    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
                  ),
                }),
              ),
              yield* api.request(actors.member, "GET", `${path}/profiles`),
            );
            expect(unchanged?.accounts).toEqual(initial.accounts);
            expect(added?.accounts).toEqual({ extra: [] });
            expect(added?.name).toBe(label);
          }
          yield* browser.use("Choose the profile's Inbox account", (page) =>
            page
              .getByRole("region", { name: "Inbox (service)", exact: true })
              .getByRole("button", { name: "Add Inbox account", exact: true })
              .click(),
          );
          if (label !== "Personal inbox")
            yield* browser.use("Connect a new account instead of a saved one", (page) =>
              page.getByRole("button", { name: "Connect new account", exact: true }).click(),
            );
          yield* browser.use("Name this saved account", (page) =>
            page.getByRole("textbox", { name: "Account name", exact: true }).fill(label),
          );
          yield* browser.use("Enter the synthetic credential", (page) =>
            page.getByLabel("Token", { exact: true }).fill("synthetic-inbox-key"),
          );
          yield* browser.use("Complete account connection", (page) =>
            page.getByRole("button", { name: "Connect account", exact: true }).click(),
          );
          yield* browser.use("Open the newly connected account's tools", (page) =>
            page.getByRole("link", { name: "Tools", exact: true }).click(),
          );
          yield* browser.use("The account's full tool list appears", (page) =>
            page.getByRole("button", { name: "queries.who", exact: true }).waitFor(),
          );
        }
        const entries = yield* body(
          Schema.Array(Setup),
          yield* api.request(actors.member, "GET", `${path}/profiles`),
        );
        expect(entries).toHaveLength(2);
        const first = entries[0],
          second = entries[1];
        if (!first || !second) return yield* Effect.die("Missing saved setups");
      }),
    ),
  );
  it.effect(scenarios.profilePicker.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, browser, files, app, path, url, first, second } =
          yield* seededProfileFixture;
        yield* browser.login(actors.member);
        yield* browser.use("Open the app without a selected account", (page) =>
          page.goto(`${url}?view=tools`),
        );
        yield* Effect.gen(function* () {
          yield* browser.use("Choose Work inbox", (page) =>
            page.getByRole("button", { name: "Choose profile", exact: true }).click(),
          );
          yield* browser.use("Choose Work inbox", (page) =>
            page.getByRole("menuitemradio", { name: "Work inbox", exact: true }).click(),
          );
          yield* browser.use("Choose Work inbox", (page) =>
            page.getByRole("button", { name: "queries.who", exact: true }).waitFor(),
          );
          expect(
            yield* browser.use("Choose Work inbox", (page) =>
              page.getByRole("button", { name: "queries.who", exact: true }).count(),
            ),
          ).toBe(1);
        });
        yield* browser.checkpoint("One profile tool catalog");
        yield* browser.use("Inspect the work tool", (page) =>
          page.getByRole("button", { name: "queries.who", exact: true }).click(),
        );
        yield* browser.use("Run using the work account", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).click(),
        );
        yield* browser.use("Wait for the work result", (page) =>
          page.getByRole("region", { name: "Tool result" }).waitFor(),
        );
        expect(
          yield* browser.use("Read the work account result", (page) =>
            page.getByRole("region", { name: "Tool result" }).textContent(),
          ),
        ).toContain(second.accounts.service);
        const other = yield* browser.use("Open an independent app tab", (page) =>
          page.context().newPage(),
        );
        yield* browser.use("Load the work context in the second tab", () =>
          other.goto(`${url}?view=tools&profile=${second.id}&tool=queries.who`),
        );
        yield* browser.use("Run in the second tab", () =>
          other.getByRole("button", { name: "Run tool", exact: true }).click(),
        );
        yield* browser.use("The second result is ready", () =>
          other.getByRole("region", { name: "Tool result" }).waitFor(),
        );
        yield* Effect.gen(function* () {
          yield* browser.use("Switch only the first tab to Personal inbox", (page) =>
            page.getByRole("button", { name: "Choose profile", exact: true }).click(),
          );
          yield* browser.use("Switch only the first tab to Personal inbox", (page) =>
            page.getByRole("menuitemradio", { name: "Personal inbox", exact: true }).click(),
          );
          yield* browser.use("Switch only the first tab to Personal inbox", (page) =>
            page.getByRole("button", { name: "queries.who", exact: true }).waitFor(),
          );
          expect(
            new URL(
              yield* browser.use("Read the selected profile", (page) =>
                Promise.resolve(page.url()),
              ),
            ).searchParams.get("tool"),
          ).toBeNull();
          yield* browser.use("Switch only the first tab to Personal inbox", (page) =>
            page.getByRole("button", { name: "queries.who", exact: true }).click(),
          );
        });
        expect(
          yield* browser.use("Old tool output is gone after switching", (page) =>
            page.getByRole("region", { name: "Tool result" }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Run with the personal scalar account", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).click(),
        );
        yield* browser.use("The personal result is ready", (page) =>
          page.getByRole("region", { name: "Tool result" }).waitFor(),
        );
        expect(
          yield* browser.use("Read the personal account result", (page) =>
            page.getByRole("region", { name: "Tool result" }).textContent(),
          ),
        ).toContain(first.accounts.service);
        expect(
          yield* browser.use("The second tab still shows the work result", () =>
            other.getByRole("region", { name: "Tool result" }).textContent(),
          ),
        ).toContain(second.accounts.service);
        expect(
          yield* browser.use("The second tab retains its URL", () => Promise.resolve(other.url())),
        ).toContain(second.id);
        yield* browser.checkpoint("Account picker changes one tab and clears old results");
        yield* browser.use("Manage account selections", (page) =>
          page
            .getByRole("navigation", { name: "App navigation", exact: true })
            .getByRole("link", { name: "Accounts", exact: true })
            .click(),
        );
        yield* browser.use("The array selection uses account cards", (page) =>
          page
            .getByRole("region", { name: "Inbox (extra)", exact: true })
            .getByRole("button", { name: "Add Inbox account", exact: true })
            .click(),
        );
        yield* browser.checkpoint("Personal accounts can be selected together");
        yield* browser.use("Add Work inbox to the array requirement", (page) =>
          page
            .getByRole("dialog")
            .getByRole("checkbox", { name: /Work inbox/ })
            .check(),
        );
        const read = yield* holdQuery(
          [actors.organization.id, actors.organization.slug].map(
            (org) => `/api/organizations/${org}/apps/${app.id}/profiles`,
          ),
          "fail",
        );
        yield* refreshVisiblePage;
        yield* read.requested;
        expect(
          yield* browser.use("The array draft remains while metadata loads", (page) =>
            page
              .getByRole("dialog")
              .getByRole("checkbox", { name: /Work inbox/ })
              .isChecked(),
          ),
        ).toBe(true);
        yield* read.release;
        yield* browser.use("The read failure is visible", (page) =>
          page.getByText("Unable to complete this request", { exact: true }).first().waitFor(),
        );
        expect(
          yield* browser.use("The array draft survives a failed refresh", (page) =>
            page
              .getByRole("dialog")
              .getByRole("checkbox", { name: /Work inbox/ })
              .isChecked(),
          ),
        ).toBe(true);
        yield* browser.use("Save the scalar and array selection", (page) =>
          page.getByRole("button", { name: "Use selected accounts", exact: true }).click(),
        );
        yield* browser.use("Open the selected tools", (page) =>
          page.getByRole("link", { name: "Tools", exact: true }).click(),
        );
        yield* browser.use("Return to the selected tools", (page) =>
          page.getByRole("button", { name: "queries.who", exact: true }).first().waitFor(),
        );
        const saved = yield* body(
          Setup,
          yield* api.request(actors.member, "GET", `${path}/profiles/${first.id}`),
        );
        expect(saved.accounts.service).toBe(first.accounts.service);
        expect(saved.accounts.extra).toEqual([second.accounts.service]);
        expect(
          yield* body(
            Setup,
            yield* api.request(actors.member, "GET", `${path}/profiles/${second.id}`),
          ),
        ).toEqual(second);
        expect(
          yield* body(
            Schema.Array(Schema.Unknown),
            yield* api.request(actors.owner, "GET", `${path}/profiles`),
          ),
        ).toEqual([]);
        const changed = yield* saveAndDeploy(actors.owner, path, {
          files: files.map((file) =>
            file.path === "index.ts"
              ? {
                  ...file,
                  content: file.content.replace(
                    "queries:{who}",
                    'queries:{who,version:query({input:object({})},async()=>"two")}',
                  ),
                }
              : file,
          ),
        });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        yield* browser.use("The personal profile follows the new deployment", (page) =>
          page.getByRole("button", { name: "queries.version", exact: true }).first().waitFor(),
        );
        yield* browser.use("The second tab follows the same deployment", () =>
          other.getByRole("button", { name: "queries.version", exact: true }).first().waitFor(),
        );
        yield* browser.use("Review the picker on a phone", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        expect(
          yield* browser.use("The app has no horizontal overflow", (page) =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ),
        ).toBe(true);
        yield* browser.checkpoint("Account picker on a phone");
      }),
    ),
  );

  it.effect(scenarios.profileAppTabs.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, browser, app, path, url, first, second } = yield* seededProfileFixture;
        expect(
          (yield* api.request(actors.member, "PATCH", `${path}/profiles/${first.id}`, {
            expectedRevision: first.revision,
            accounts: { service: first.accounts.service, extra: [second.accounts.service] },
          })).status,
        ).toBe(200);
        yield* browser.login(actors.member);
        yield* browser.use("Open the selected profile", (page) =>
          page.goto(`${url}?view=tools&profile=${first.id}`),
        );
        const appUrl = yield* waitForAppUrl(actors.member, `${path}/ui`);
        const selectedAppUrl = yield* browser.use(
          "The Open app link carries the selected profile",
          (page) => page.getByRole("link", { name: "Open app", exact: true }).getAttribute("href"),
        );
        if (selectedAppUrl === null) return yield* Effect.die(new Error("Missing Open app link"));
        expect(new URL(selectedAppUrl).searchParams.get("profile")).toBe(first.id);
        yield* browser.omitNetworkTrace;
        yield* browser.use("Open an app bookmark without a selected account", (page) =>
          page.goto(`${appUrl}/inbox?folder=unread#message`),
        );
        yield* browser.use("Choose an account before authored UI runs", (page) =>
          page.getByRole("heading", { name: `Open ${app.name}`, exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Authored app is not rendered before choosing", (page) =>
            page.locator("#identity").count(),
          ),
        ).toBe(0);
        yield* browser.use("Launch Personal with its array selection", (page) =>
          page.getByRole("link", { name: "Personal inbox", exact: true }).click(),
        );

        yield* browser.use("The app client resolves the selected account", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        const uiIdentity = yield* browser.use("Read the app SDK's account context", (page) =>
          page.locator("#identity").textContent(),
        );
        expect(uiIdentity).toContain(first.accounts.service);
        const launched = yield* browser.use("Read explicit tab context and deep link", (page) =>
          Promise.resolve(page.url()),
        );
        const launchedUrl = new URL(launched);
        expect(launchedUrl.pathname).toBe("/inbox");
        expect(launchedUrl.searchParams.get("folder")).toBe("unread");
        expect(launchedUrl.searchParams.get("profile")).toBe(first.id);
        expect(launchedUrl.hash).toBe("#message");
        const secondTab = yield* browser.use("Open a second app tab", (page) =>
          page.context().newPage(),
        );
        yield* browser.use("Open Work directly in its own tab", () =>
          secondTab.goto(`${appUrl}/?profile=${second.id}`),
        );
        yield* browser.use("Work app tab is ready", () =>
          secondTab.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        expect(
          yield* browser.use("Work tab uses Work", () =>
            secondTab.locator("#identity").textContent(),
          ),
        ).toContain(second.accounts.service);
        expect(
          yield* browser.use("First app tab remains Personal", (page) =>
            page.locator("#identity").textContent(),
          ),
        ).toContain(first.accounts.service);
        yield* browser.use("Close the second app tab", () => secondTab.close());

        expect(uiIdentity).toContain('"context":{"auth":false,"profile":false}');
        const stranger = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(actors.admin, "POST", `${path}/profiles`, {
            accounts: { extra: [] },
            idempotencyKey: "other-user",
          }),
        );
        const activeDeployment = app.activeDeployment;
        expect(
          yield* browser.use("The app session rejects another user's profile", (page) =>
            page.evaluate(
              (input) =>
                fetch("/_executor/api/query", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(input),
                }).then((response) => response.status),
              {
                deployment: activeDeployment,
                profile: stranger.id,
                name: "who",
                input: {},
              },
            ),
          ),
        ).toBe(403);
        yield* browser.checkpoint("Authored app receives the selected profile through its SDK");
        const workSetup = yield* body(
          Schema.Struct({ revision: Schema.Number }),
          yield* api.request(actors.member, "GET", `${path}/profiles/${second.id}`),
        );
        expect(
          (yield* api.request(actors.member, "PATCH", `${path}/profiles/${second.id}/enabled`, {
            enabled: false,
            expectedRevision: workSetup.revision,
          })).status,
        ).toBe(200);
        yield* browser.use("A sole enabled account opens directly", (page) =>
          page.goto(`${appUrl}/inbox?folder=sent`),
        );
        yield* browser.use("Sole account authored UI is ready", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        expect(
          new URL(
            yield* browser.use("Sole account URL", (page) => Promise.resolve(page.url())),
          ).searchParams.get("profile"),
        ).toBe(first.id);
        const disabledPage = yield* browser.use(
          "Disabled explicit app account is rejected",
          (page) => page.goto(`${appUrl}/?profile=${second.id}`),
        );
        expect(disabledPage?.status()).toBe(403);
      }),
    ),
  );
});
