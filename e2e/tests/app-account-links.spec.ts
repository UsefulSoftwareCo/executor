/**
 * The accounts an app runs with are the caller's links to it, made per requirement and changed
 * only in its Accounts tab: a plain requirement uses its one linked account, which linking or
 * connecting another replaces, even when a many() requirement shares its provider; many() uses
 * every account linked to it. No call, tab or page chooses accounts.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import {
  accountLinks,
  connectionsPath,
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
} from "../support/app-accounts.ts";
import { accountChoices, chooseAccount, linkedLabels } from "../support/account-choices.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { advanceToReconciliation, installBrowserClock } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

/** Inbox has a plain and a many() requirement on one provider, each linked on its own. */
const source = `import {defineApp,defineProvider,secrets,query,object,string, router} from "apps";
const service=defineProvider({name:"Inbox",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export const who=query({input:object({})},async ctx=>({context:{auth:"auth" in ctx},account:ctx.user.accounts.service.id,extra:ctx.user.accounts.extra.map(a=>a.id)}));
export default defineApp({user: { accounts:{service,extra:service.many()} }},{tools: router({ who })});`;
/** What the `who` tool and the authored page report about the accounts a call ran with. */
const Identity = Schema.Struct({
  context: Schema.Struct({ auth: Schema.Boolean }),
  account: Schema.String,
  extra: Schema.Array(Schema.String),
});
const identity = Schema.decodeUnknownEffect(Schema.fromJsonString(Identity));
/** The Mailbox `who` tool's result: the account a call ran as and the credential it received. */
const Mailbox = Schema.Struct({ account: Schema.String, token: Schema.String });
/** A dashboard tool run's response, which carries the completed call's value. */
const Ran = Schema.fromJsonString(
  Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Json }),
);
const ranIdentity = (text: string) =>
  Schema.decodeUnknownEffect(Ran)(text).pipe(
    Effect.flatMap((run) => Schema.decodeUnknownEffect(Identity)(run.value)),
  );
const ranMailbox = (text: string) =>
  Schema.decodeUnknownEffect(Ran)(text).pipe(
    Effect.flatMap((run) => Schema.decodeUnknownEffect(Mailbox)(run.value)),
  );
/** The account search parameter tabs used to carry; nothing reads it any more. */
const urlChoice = (url: string) => new URL(url).searchParams.get("accounts");

/** Deploy `files` as the owner and let everyone in the organization use the app. */
const sharedApp = (
  name: string,
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      browser = yield* Browser;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `${name} ${randomUUID().slice(0, 8)}`,
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
    const owned: { readonly actor: Session; readonly id: string }[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* api.request(actors.owner, "DELETE", path);
        for (const account of owned)
          yield* api.request(account.actor, "DELETE", `${prefix}/accounts/${account.id}`);
      }).pipe(Effect.orDie),
    );
    /** Connect an account for `requirement` from the app, which links it to that one for `actor`. */
    const connect = (actor: Session, requirement: string, label: string, token: string) =>
      Effect.gen(function* () {
        const connection = yield* body(
          Resource,
          yield* api.request(actor, "POST", connectionsPath(path, "user", requirement), {
            destination: { kind: "personal" },
          }),
        );
        const account = yield* api.request(
          actor,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "key", label, fields: { token } },
        );
        expect(account.status, JSON.stringify(account.body)).toBe(200);
        const id = (yield* body(Resource, account)).id;
        owned.push({ actor, id });
        return id;
      });
    /** The IDs of the accounts `actor` has saved, linked to an app or not. */
    const saved = (actor: Session) =>
      Effect.gen(function* () {
        const inventory = yield* body(
          Schema.Struct({ accounts: Schema.Array(Schema.Struct({ id: Schema.String })) }),
          yield* api.request(actor, "GET", `${prefix}/inventory`),
        );
        return inventory.accounts.map((account) => account.id);
      });
    return { api, actors, browser, prefix, files, app, path, url, owned, connect, saved };
  });

const inboxFixture = sharedApp("Inbox", [
  { path: "index.ts", content: source },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Inbox</title></head><body><h1>Inbox identity</h1><pre id="identity"></pre><p role="status">Loading</p><script type="module" src="./main.ts"></script></body></html>',
  },
  {
    path: "ui/main.ts",
    content: `import {object,string,array,boolean} from "apps";import {createAppClient,queryReference} from "apps/client";import type {who} from "../index.ts";
const client=createAppClient();client.query(queryReference<typeof who>("who"),{},object({context:object({auth:boolean()}),account:string(),extra:array(string())})).then(value=>{document.querySelector("#identity").textContent=JSON.stringify(value);document.querySelector('[role="status"]').textContent="Ready";}).catch(()=>{document.querySelector('[role="status"]').textContent="Load failed";});`,
  },
  appsManifest,
]);

/**
 * The member connects two Inbox accounts for many() from the app, which links both to it, and
 * links the newer one to the plain requirement too.
 */
const linkedFixture = Effect.gen(function* () {
  const fixture = yield* inboxFixture;
  const { actors, path, connect } = fixture;
  const personal = yield* connect(actors.member, "extra", "Personal inbox", "synthetic-inbox");
  const work = yield* connect(actors.member, "extra", "Work inbox", "synthetic-inbox");
  yield* linkAccount(actors.member, path, "service", work);
  expect(yield* accountLinks(actors.member, path)).toEqual([
    ["extra", personal],
    ["extra", work],
    ["service", work],
  ]);
  return { ...fixture, personal, work };
});

/** The tool runner's read-only line naming the accounts a call runs with. */
const runningAs = (page: Page) => page.getByText(/^Running as/).textContent();

/** Run the selected tool and return the call's JSON result once the page shows it. */
const runTool = (page: Page) =>
  Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/tools/run"),
    ),
    page.getByRole("button", { name: "Run tool", exact: true }).click(),
  ]).then(([response]) =>
    page
      .getByRole("region", { name: "Tool result" })
      .waitFor()
      .then(() => response.text()),
  );

/**
 * A requirement's linked account labels (its checked radios or checkboxes, in the order shown),
 * read once they are `expected`. A timeout falls through so the assertion reports the accounts
 * actually checked.
 */
const linkedRows = (region: Locator, provider: string, expected: readonly string[]) =>
  region
    .elementHandle()
    .then((root) =>
      region.page().waitForFunction(
        (args) => {
          const list = args.root.querySelector(`ul[aria-label="${args.list}"]`);
          const shown = Array.from(
            list?.querySelectorAll(
              '[role="radio"][aria-checked="true"], [role="checkbox"][aria-checked="true"]',
            ) ?? [],
            (control) => control.getAttribute("aria-label") ?? "",
          );
          return JSON.stringify(shown) === JSON.stringify(args.expected);
        },
        { root, list: `${provider} accounts`, expected: [...expected] },
        { timeout: 10_000 },
      ),
    )
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
    })
    .then(() => linkedLabels(region, provider));

/** Every account a requirement lists, with whether its control is checked, in the order shown. */
const choiceStates = (region: Locator, provider: string) =>
  accountChoices(region, provider)
    .locator('[role="radio"], [role="checkbox"]')
    .evaluateAll((controls) =>
      controls.map((control) => [
        control.getAttribute("aria-label") ?? "",
        control.getAttribute("aria-checked") ?? "",
      ]),
    );

layer(HostedLive, { excludeTestServices: true })("App account links", (it) => {
  it.effect(scenarios.accountLinking.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, browser, path, url, owned, saved } = yield* inboxFixture;
        const before = (yield* saved(actors.member)).sort();
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([]);
        yield* browser.login(actors.member);
        yield* browser.use("Open the shared inbox app", (page) => page.goto(`${url}?view=tools`));
        yield* browser.use("Tools ask for a linked account first", (page) =>
          page.getByText("Link an account in Accounts to start using this app.").waitFor(),
        );
        const openTab = (name: "Accounts" | "Tools") =>
          browser.use(`Open ${name}`, (page) =>
            page
              .getByRole("navigation", { name: "App navigation", exact: true })
              .getByRole("link", { name, exact: true })
              .click(),
          );
        const region = (slot: "service" | "extra") =>
          browser.use(`Find Inbox (${slot})`, (page) =>
            Promise.resolve(page.getByRole("region", { name: `Inbox (${slot})`, exact: true })),
          );
        const connect = (slot: "service" | "extra", label: string) =>
          Effect.gen(function* () {
            const requirement = yield* region(slot);
            yield* browser.use(`Connect a new account for Inbox (${slot})`, () =>
              requirement.getByRole("button", { name: "Connect new account", exact: true }).click(),
            );
            yield* browser.use("Enter the synthetic credential", (page) =>
              page.getByLabel("Token", { exact: true }).fill("synthetic-inbox-key"),
            );
            yield* browser.use("Complete account connection", (page) =>
              page.getByRole("button", { name: "Connect account", exact: true }).click(),
            );
            yield* browser.use("Name this saved account", (page) =>
              nameConnectedAccount(page, label),
            );
          });
        /** Run `who` from the Tools tab, reading the runner's account line first. */
        const runWho = (step: string) =>
          Effect.gen(function* () {
            yield* browser.use(`${step}: open the tool`, (page) =>
              page.goto(`${url}?view=tools&tool=who`),
            );
            const line = yield* browser.use(`${step}: read the account line`, runningAs);
            const ran = yield* ranIdentity(yield* browser.use(`${step}: run the tool`, runTool));
            return { line, ran };
          });

        yield* openTab("Accounts");
        yield* connect("service", "Personal inbox");
        const [personal] = yield* linkedAccountIds(actors.member, path);
        if (personal === undefined)
          return yield* Effect.die("The connected account was not linked");
        owned.push({ actor: actors.member, id: personal });
        // Connecting from the plain requirement links the account to it only, not to the many()
        // requirement that shares its provider.
        expect(yield* accountLinks(actors.member, path)).toEqual([["service", personal]]);
        const alone = yield* runWho("Run with the one linked account");
        expect(alone.line).toBe("Running asPersonal inbox (Inbox)");
        expect(alone.ran).toEqual({
          context: { auth: false },
          account: personal,
          extra: [],
        });

        yield* openTab("Accounts");
        yield* Effect.gen(function* () {
          const extra = yield* region("extra");
          yield* browser.use("Start connecting another account", () =>
            extra.getByRole("button", { name: "Connect new account", exact: true }).click(),
          );
          yield* browser.use("Draft a credential", (page) =>
            page.getByLabel("Token", { exact: true }).fill("synthetic-cancelled-key"),
          );
          const draft = yield* browser.use("Find the draft dialog", (page) =>
            Promise.resolve(page.getByRole("dialog", { name: "Connect Inbox", exact: true })),
          );
          yield* browser.use("Cancel the draft", () =>
            draft.getByRole("button", { name: "Close", exact: true }).click(),
          );
          yield* browser.use("The draft dialog closes", () => draft.waitFor({ state: "hidden" }));
        });
        expect((yield* saved(actors.member)).sort()).toEqual([...before, personal].sort());
        expect(yield* accountLinks(actors.member, path)).toEqual([["service", personal]]);

        // Connecting another account from the many() requirement links it there only; the plain
        // requirement keeps its account.
        const plainOne = yield* region("service");
        // The closing dialog hides the page from role queries until it unmounts.
        yield* browser.use("The plain requirement's actions are shown", () =>
          plainOne.getByRole("button", { name: "Connect new account", exact: true }).waitFor(),
        );
        yield* connect("extra", "Work inbox");
        const linked = yield* accountLinks(actors.member, path);
        const work = linked.find(([, id]) => id !== personal)?.[1];
        if (work === undefined) return yield* Effect.die("The second account was not linked");
        owned.push({ actor: actors.member, id: work });
        expect(linked).toEqual([
          ["extra", work],
          ["service", personal],
        ]);
        expect((yield* saved(actors.member)).sort()).toEqual([...before, personal, work].sort());
        for (const [slot, label] of [
          ["service", "Personal inbox"],
          ["extra", "Work inbox"],
        ] as const)
          expect(
            yield* browser.use(`Inbox (${slot}) lists its own linked account`, (page) =>
              linkedRows(
                page.getByRole("region", { name: `Inbox (${slot})`, exact: true }),
                "Inbox",
                [label],
              ),
            ),
          ).toEqual([label]);
        yield* browser.checkpoint("Two linked accounts");
        // The plain requirement runs with its link, many() with its own. The runner names the
        // plain requirement's account first, then the many() links.
        const both = yield* runWho("Run with both linked accounts");
        expect(both.line).toBe("Running asPersonal inbox (Inbox), Work inbox (Inbox)");
        expect(both.ran).toEqual({
          context: { auth: false },
          account: personal,
          extra: [work],
        });
        expect(
          yield* browser.use("No account is chosen in the tab", (page) =>
            Promise.all([
              Promise.resolve(urlChoice(page.url())),
              page.getByRole("combobox", { name: /account$/ }).count(),
            ]),
          ),
        ).toEqual([null, 0]);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([work, personal]);
      }),
    ),
  );

  it.effect(scenarios.accountChoice.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        // Only a plain requirement uses Mailbox, so each member keeps one linked account.
        const { actors, browser, path, url, owned, connect, saved, api } = yield* sharedApp(
          "Mailbox",
          [
            {
              path: "index.ts",
              content: `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Mailbox",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export const who=query({input:object({})},async ctx=>({account:ctx.user.accounts.service.id,token:ctx.user.accounts.service.fields.token}));
export default defineApp({user: { accounts:{service} }},{tools: router({ who })});`,
            },
            appsManifest,
          ],
        );
        const call = (actor: Session) =>
          Effect.gen(function* () {
            const called = yield* api.request(actor, "POST", `${path}/tools/call`, {
              tool: "who",
              kind: "query",
              input: {},
            });
            expect(called.status, JSON.stringify(called.body)).toBe(200);
            return yield* body(Mailbox, called);
          });
        // Connecting Personal after Work from the app replaced Work, which stays saved.
        const work = yield* connect(actors.member, "service", "Work mailbox", "synthetic-work");
        const personal = yield* connect(
          actors.member,
          "service",
          "Personal mailbox",
          "synthetic-personal",
        );
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([personal]);
        expect(yield* saved(actors.member)).toEqual(expect.arrayContaining([work, personal]));
        // Another member links their own account to the same app.
        const other = yield* connect(actors.admin, "service", "Admin mailbox", "synthetic-admin");
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([other]);
        expect(yield* call(actors.member)).toEqual({
          account: personal,
          token: "synthetic-personal",
        });

        yield* browser.login(actors.member);
        yield* browser.use("Open the app's accounts", (page) => page.goto(`${url}?view=accounts`));
        const mailbox = yield* browser.use("Find the Mailbox requirement", (page) =>
          Promise.resolve(page.getByRole("region", { name: "Mailbox", exact: true })),
        );
        // The member's saved accounts are offered once the requirement's choices load.
        yield* browser.use("The member's other saved account is offered", () =>
          accountChoices(mailbox, "Mailbox")
            .getByRole("radio", { name: "Work mailbox", exact: true })
            .waitFor(),
        );
        expect(
          yield* browser.use("The linked account is selected among the member's own", () =>
            linkedRows(mailbox, "Mailbox", ["Personal mailbox"]).then((rows) =>
              Promise.all([
                Promise.resolve(rows),
                mailbox
                  .getByText("The app uses this account when you use it.", { exact: true })
                  .count(),
                choiceStates(mailbox, "Mailbox"),
                mailbox.getByRole("button", { name: "Replace", exact: true }).count(),
                mailbox.getByRole("button", { name: "Link an existing account" }).count(),
              ]),
            ),
          ),
        ).toEqual([
          ["Personal mailbox"],
          1,
          // Only the member's accounts are offered; the admin's account is not.
          [
            ["Personal mailbox", "true"],
            ["Work mailbox", "false"],
          ],
          0,
          0,
        ]);
        yield* browser.checkpoint("Replacing the linked mailbox");
        const linked = yield* browser.use("Link Work mailbox in place of Personal", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "PUT" &&
                new URL(response.url()).pathname.endsWith(`/accounts/user/service/${work}`),
            ),
            chooseAccount(mailbox, "Mailbox", "Work mailbox"),
          ]).then(([response]) => response.status()),
        );
        expect(linked).toBe(200);
        expect(
          yield* browser.use("Work mailbox replaces Personal mailbox", () =>
            linkedRows(mailbox, "Mailbox", ["Work mailbox"]).then((rows) =>
              Promise.all([Promise.resolve(rows), choiceStates(mailbox, "Mailbox")]),
            ),
          ),
        ).toEqual([
          ["Work mailbox"],
          // The replaced account stays saved and offered.
          [
            ["Personal mailbox", "false"],
            ["Work mailbox", "true"],
          ],
        ]);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([work]);
        expect(yield* saved(actors.member), "the replaced account stays saved").toEqual(
          expect.arrayContaining([work, personal]),
        );
        expect(yield* call(actors.member)).toEqual({ account: work, token: "synthetic-work" });

        // Connecting a new account replaces the linked one too.
        yield* browser.use("Connect a new account", () =>
          mailbox.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        yield* browser.use("Enter the new account's credential", (page) =>
          page.getByLabel("Token", { exact: true }).fill("synthetic-new"),
        );
        yield* browser.use("Complete the connection", (page) =>
          page.getByRole("button", { name: "Connect account", exact: true }).click(),
        );
        yield* browser.use("Name the new account", (page) =>
          nameConnectedAccount(page, "New mailbox"),
        );
        expect(
          yield* browser.use("The new account replaces Work mailbox", () =>
            linkedRows(mailbox, "Mailbox", ["New mailbox"]),
          ),
        ).toEqual(["New mailbox"]);
        const [created] = yield* linkedAccountIds(actors.member, path);
        if (created === undefined || [work, personal].includes(created))
          return yield* Effect.die("The new account was not linked");
        owned.push({ actor: actors.member, id: created });
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([created]);
        expect(yield* saved(actors.member), "both replaced accounts stay saved").toEqual(
          expect.arrayContaining([work, personal, created]),
        );
        yield* browser.checkpoint("A connected account replaced the linked one");

        // Later calls run as the new account, from the Tools tab and through the API.
        yield* browser.use("Open the tool", (page) => page.goto(`${url}?view=tools&tool=who`));
        expect(yield* browser.use("The runner names the account it runs as", runningAs)).toBe(
          "Running asNew mailbox (Mailbox)",
        );
        expect(yield* ranMailbox(yield* browser.use("Run the tool", runTool))).toEqual({
          account: created,
          token: "synthetic-new",
        });
        expect(yield* call(actors.member)).toEqual({ account: created, token: "synthetic-new" });
        // The other member's link to the same app is untouched.
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([other]);
        expect(yield* call(actors.admin)).toEqual({ account: other, token: "synthetic-admin" });
      }),
    ),
  );

  it.effect(scenarios.accountSetDeclarations.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        // The skill's description counts the many() accounts it was evaluated with.
        const { actors, browser, path, url, owned, api, saved } = yield* sharedApp("Inbox set", [
          {
            path: "index.ts",
            content: `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Inbox",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({user: { accounts:{extra:service.many()} }},async ctx=>({
  tools: router({ ids: query({input:object({})},async()=>ctx.user.accounts.extra.map(a=>a.id)) }),
  skills:[{name:"linked-inbox",description:"Linked inboxes: "+ctx.user.accounts.extra.length,
    files:[{path:"SKILL.md",content:"---\\nname: linked-inbox\\ndescription: Linked inboxes\\n---\\nInboxes"}]}],
}));`,
          },
          appsManifest,
        ]);
        /** The accounts a call's many() requirement received. */
        const used = Effect.gen(function* () {
          const called = yield* api.request(actors.member, "POST", `${path}/tools/call`, {
            tool: "ids",
            kind: "query",
            input: {},
          });
          expect(called.status, JSON.stringify(called.body)).toBe(200);
          return yield* body(Schema.Array(Schema.String), called);
        });
        yield* browser.login(actors.member);
        yield* browser.use("Open the app's accounts", (page) => page.goto(`${url}?view=accounts`));
        const inbox = yield* browser.use("Find the Inbox requirement", (page) =>
          Promise.resolve(page.getByRole("region", { name: "Inbox", exact: true })),
        );
        const connect = (label: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Connect ${label}`, () =>
              inbox.getByRole("button", { name: "Connect new account", exact: true }).click(),
            );
            yield* browser.use(`Enter ${label}'s credential`, (page) =>
              page.getByLabel("Token", { exact: true }).fill("synthetic-inbox-key"),
            );
            yield* browser.use(`Save ${label}`, (page) =>
              page.getByRole("button", { name: "Connect account", exact: true }).click(),
            );
            yield* browser.use(`Name ${label}`, (page) => nameConnectedAccount(page, label));
            const linked = yield* linkedAccountIds(actors.member, path);
            const added = linked.at(-1);
            if (added === undefined) return yield* Effect.die(`${label} was not linked`);
            owned.push({ actor: actors.member, id: added });
            return added;
          });
        const openTab = (name: string) =>
          browser.use(`Open ${name}`, (page) =>
            page
              .getByRole("navigation", { name: "App navigation", exact: true })
              .getByRole("link", { name, exact: true })
              .click(),
          );
        /** The Skills tab shows the count for the current links, and no other count. */
        const skillsCount = (count: number) =>
          Effect.gen(function* () {
            const listed = yield* api.request(actors.member, "GET", `${path}/skills`);
            expect(listed.status, JSON.stringify(listed.body)).toBe(200);
            expect(
              (yield* body(
                Schema.Struct({
                  skills: Schema.Array(Schema.Struct({ description: Schema.String })),
                }),
                listed,
              )).skills.map((skill) => skill.description),
              "the skills API reads with the current links",
            ).toEqual([`Linked inboxes: ${count}`]);
            yield* openTab("Skills");
            yield* browser.use(`Skills use ${count} linked inboxes`, (page) =>
              page.getByText(`Linked inboxes: ${count}`, { exact: true }).waitFor(),
            );
            expect(
              yield* browser.use("The previous account set's skills are gone", (page) =>
                page.getByText(/^Linked inboxes: \d+$/).allTextContents(),
              ),
            ).toEqual([`Linked inboxes: ${count}`]);
            yield* openTab("Accounts");
          });
        const first = yield* connect("First inbox");
        expect(yield* used).toEqual([first]);
        yield* skillsCount(1);
        // Connecting another many() account adds it: every call now uses both.
        const second = yield* connect("Second inbox");
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([first, second]);
        expect(yield* used).toEqual([first, second]);
        // The closing naming dialog hides the page from role and text queries until it unmounts.
        yield* browser.use("The Inbox requirement is shown again", () =>
          inbox.getByRole("button", { name: "Connect new account", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("many() lists every linked account", () =>
            Promise.all([
              linkedRows(inbox, "Inbox", ["First inbox", "Second inbox"]),
              inbox.getByText("The app uses every account you link.", { exact: true }).count(),
              inbox.getByRole("button", { name: "Replace", exact: true }).count(),
            ]),
          ),
        ).toEqual([["First inbox", "Second inbox"], 1, 0]);
        yield* skillsCount(2);

        // Unlinking one narrows every call to the rest; the account stays saved.
        yield* browser.use("Unlink First inbox", (page) =>
          inbox
            .getByRole("button", { name: "Manage First inbox", exact: true })
            .click()
            .then(() => page.getByRole("menuitem", { name: "Unlink", exact: true }).click()),
        );
        const unused = yield* browser.use("Find the unused account prompt", (page) =>
          Promise.resolve(page.getByRole("dialog", { name: "Delete unused account?" })),
        );
        yield* browser.use("Keep the unlinked account", () =>
          unused.getByRole("button", { name: "Keep account", exact: true }).click(),
        );
        yield* browser.use("The prompt closes", () => unused.waitFor({ state: "hidden" }));
        expect(
          yield* browser.use("Only the remaining account is checked", () =>
            linkedRows(inbox, "Inbox", ["Second inbox"]).then((rows) =>
              Promise.all([Promise.resolve(rows), choiceStates(inbox, "Inbox")]),
            ),
          ),
        ).toEqual([
          ["Second inbox"],
          // The unlinked account stays saved and offered, unchecked.
          [
            ["First inbox", "false"],
            ["Second inbox", "true"],
          ],
        ]);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([second]);
        expect(yield* used).toEqual([second]);
        expect(yield* saved(actors.member)).toEqual(expect.arrayContaining([first, second]));
        yield* skillsCount(1);

        // Checking the saved account again adds it back, newest last. The list keeps its rows in
        // name order, so linking does not move them; the link order shows in the calls.
        yield* browser.use("Link First inbox again", () =>
          chooseAccount(inbox, "Inbox", "First inbox"),
        );
        expect(
          yield* browser.use("Both accounts are linked again", () =>
            linkedRows(inbox, "Inbox", ["First inbox", "Second inbox"]),
          ),
        ).toEqual(["First inbox", "Second inbox"]);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([second, first]);
        expect(yield* used).toEqual([second, first]);
        yield* skillsCount(2);
      }),
    ),
  );

  it.effect(scenarios.accountDeployment.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, browser, files, path, url } = yield* linkedFixture;
        const line = "Running asWork inbox (Inbox), Personal inbox (Inbox)";
        yield* browser.login(actors.member);
        yield* installBrowserClock;
        yield* browser.use("Open the tool before deployment", (page) =>
          page.goto(`${url}?view=tools&tool=who`),
        );
        yield* browser.use("The first tab has the original catalog", (page) =>
          page.getByRole("button", { name: "who", exact: true }).waitFor(),
        );
        const other = yield* browser.use("Open another tab", (page) => page.context().newPage());
        yield* browser.use("Load the tool in the second tab", () =>
          other.goto(`${url}?view=tools&tool=who`),
        );
        yield* browser.use("The second tab has the original catalog", () =>
          other.getByRole("button", { name: "who", exact: true }).waitFor(),
        );
        const changed = yield* saveAndDeploy(actors.owner, path, {
          files: files.map((file) =>
            file.path === "index.ts"
              ? {
                  ...file,
                  content: file.content.replace(
                    "tools: router({ who })",
                    'tools: router({ who,version:query({input:object({})},async()=>"two") })',
                  ),
                }
              : file,
          ),
        });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        // Both open tabs follow the deployment at their next idle reconciliation.
        yield* advanceToReconciliation;
        yield* browser.use("The first tab follows the new deployment", (page) =>
          page.getByRole("button", { name: "version", exact: true }).first().waitFor(),
        );
        yield* browser.use("The second tab follows the same deployment", () =>
          other.getByRole("button", { name: "version", exact: true }).first().waitFor(),
        );
        expect(
          yield* browser.use("Both tabs still run with the linked accounts", (page) =>
            Promise.all([runningAs(page), runningAs(other)]),
          ),
        ).toEqual([line, line]);
        yield* browser.use("Review the tool on a phone", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        expect(
          yield* browser.use("The app has no horizontal overflow", (page) =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ),
        ).toBe(true);
        yield* browser.checkpoint("Linked accounts on a phone");
      }),
    ),
  );

  it.effect(scenarios.accountAppTabs.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, browser, app, path, url, personal, work, connect } = yield* linkedFixture;
        const appUrl = yield* waitForAppUrl(actors.member, `${path}/ui`);
        yield* browser.login(actors.member);
        yield* browser.use("Open the app's tools", (page) => page.goto(`${url}?view=tools`));
        const openApp = yield* browser.use("Read the Open app link", (page) =>
          page.getByRole("link", { name: "Open app", exact: true }).getAttribute("href"),
        );
        if (openApp === null) return yield* Effect.die(new Error("Missing Open app link"));
        expect(new URL(openApp).origin).toBe(new URL(appUrl).origin);
        expect(urlChoice(openApp), "the Open app link names no accounts").toBeNull();
        yield* browser.omitNetworkTrace;
        // A bookmark into the app opens directly, keeping its path, query and fragment.
        const bookmark = `${appUrl}/inbox?folder=unread#message`;
        yield* browser.use("Open an app bookmark", (page) => page.goto(bookmark));
        yield* browser.use("The authored page is ready", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        const opened = yield* browser.use("Read the opened page", (page) =>
          Promise.all([Promise.resolve(page.url()), page.locator("#identity").textContent()]),
        );
        expect(opened[0], "the bookmark opens without a detour").toBe(bookmark);
        // The page runs with the member's links: the newest for the plain requirement, every
        // link for many().
        const linkedIdentity = { context: { auth: false }, account: work, extra: [personal, work] };
        expect(yield* identity(opened[1])).toEqual(linkedIdentity);
        yield* browser.checkpoint("Authored app runs with the linked accounts");

        const call = (accounts?: Record<string, readonly string[]>) =>
          browser.use("Call the app from its page", (page) =>
            page.evaluate(
              (input) =>
                fetch("/_executor/api/query", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(input),
                }).then((response) =>
                  response.json().then((body: unknown) => ({ status: response.status, body })),
                ),
              {
                deployment: app.activeDeployment,
                name: "who",
                input: {},
                ...(accounts === undefined ? {} : { accounts }),
              },
            ),
          );
        // Another member's account, linked by them to the same app, is never used here.
        const foreign = yield* connect(actors.admin, "service", "Admin inbox", "synthetic-admin");
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([foreign]);
        expect(yield* call()).toEqual({ status: 200, body: linkedIdentity });
        // A page that names accounts still runs with the caller's links.
        expect(yield* call({ service: [foreign], extra: [foreign] })).toEqual({
          status: 200,
          body: linkedIdentity,
        });
        expect(yield* call({ service: [personal], extra: [personal] })).toEqual({
          status: 200,
          body: linkedIdentity,
        });

        // Unlinking from many() narrows the next call to its remaining link; the plain requirement
        // keeps its own.
        yield* unlinkAccount(actors.member, path, "extra", work);
        const narrowed = { context: { auth: false }, account: work, extra: [personal] };
        expect(yield* call()).toEqual({ status: 200, body: narrowed });
        yield* browser.use("Reload the page", (page) => page.reload());
        yield* browser.use("The reloaded page is ready", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        expect(
          yield* identity(
            yield* browser.use("Read the reloaded identity", (page) =>
              page.locator("#identity").textContent(),
            ),
          ),
        ).toEqual(narrowed);
        // With no account linked to the plain requirement, the page's calls need one rather than
        // borrowing the account still linked to many().
        yield* unlinkAccount(actors.member, path, "service", work);
        expect(yield* call()).toEqual({
          status: 422,
          body: expect.objectContaining({ reason: "account_required" }),
        });
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([foreign]);
      }),
    ),
  );
});
